import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLiveConfig, serializeUpdate } from '../scripts/integration/telegram-v1-smoke.mjs';
import { NEGATIVE_TEXT, operate, readNegativeConfig, verifyNegative } from '../scripts/integration/telegram-negative-csv.mjs';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'tg-negative-offline-'));
  const bindings = {
    GATEWAY_URL: 'https://gateway.example.invalid', CONTROL_PLANE_URL: 'https://cp.example.invalid',
    CONTROL_PLANE_PRINCIPAL: 'offline', CONTROL_PLANE_PROFILE: 'integration-v1',
    CONTROL_PLANE_PRINCIPAL_SIGNATURE: '1'.repeat(64), TELEGRAM_WEBHOOK_SECRET: 'offline_secret',
    TG_SANDBOX_BOT_USERNAME: 'sandbox_test_bot', TG_SLICE_ALLOWED_CHATS: '123', TEST_CHAT_ID: 123, TEST_USER_ID: 123,
    SMOKE_UPDATE_ID: 901010099, SMOKE_MESSAGE_ID: 901010099, SMOKE_MESSAGE_DATE: 1791180000, SMOKE_TEXT: NEGATIVE_TEXT,
    INTEGRATION_UPDATE_FILE: join(directory, 'update.json'), NEGATIVE_CHECKPOINT_FILE: join(directory, 'checkpoint.json'),
    NEGATIVE_ADMISSION_FILE: join(directory, 'admission.jsonl'), NEGATIVE_CUTOVER_ID: 'offline-cutover',
    NEGATIVE_AUTODELIVERY_APPROVED: 'yes', SMOKE_POLL_INTERVAL_MS: 100,
  };
  bindings.savedUpdateBody = serializeUpdate(readLiveConfig(bindings));
  await writeFile(bindings.INTEGRATION_UPDATE_FILE, bindings.savedUpdateBody, { mode: 0o600 });
  const config = readNegativeConfig(bindings);
  const status = { taskStore: { id: config.taskId, generation: 1, status: 'failed', stage: 'finished',
    result: { failure: { code: 'ARTIFACTS_MISSING' } } }, artifacts: [],
  runs: [{ id: 'attempt-one', session_id: 'run_one', status: 'failed', generation: 1, error_class: 'ARTIFACTS_MISSING' }] };
  const deliveries = { receipt: null, terminal: { userTaskId: config.taskId, deliveryId: `terminal:${config.taskId}:g1`,
    generation: 1, chatId: 123, threadId: null, status: 'sent', attempts: 1, providerMessageId: 1400, legacyStatus: null } };
  const journal = [{ kind: 'admission', record: { userTaskId: config.taskId, runId: 'run_one', ownerGeneration: 1,
    profileId: config.profile, spec: { outputs: [{ path: 'outputs/category-results.csv' }] } } },
  { kind: 'dispatched', runId: 'run_one' }];
  await writeFile(config.admissionFile, journal.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, ...options });
    expect(options.redirect).toBe('error');
    const path = new URL(url).pathname;
    if (path === '/webhook') {
      const checkpoint = JSON.parse(await readFile(config.checkpointFile));
      expect(checkpoint.phase).toBe('submission_unknown');
      expect(options.body).toBe(bindings.savedUpdateBody);
      return Response.json({ ok: true, duplicate: false, userTaskId: config.taskId });
    }
    if (path === '/health') return Response.json({ status: 'ok', bot: config.username, mode: 'direct' });
    if (path === '/delivery-cutover') return Response.json({ ready: true, paused: false, cutoverId: config.cutoverId });
    if (path === '/status') return Response.json(status);
    if (path.startsWith('/deliveries/')) return Response.json(deliveries);
    throw new Error('Unexpected network target');
  };
  return { config, bindings, status, deliveries, journal, calls, fetchImpl, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

describe('controlled negative Telegram CSV operator, offline only', () => {
  it('requires saved exact negative bytes and explicit identity', async () => {
    const data = await fixture();
    try {
      expect(() => readNegativeConfig({ ...data.bindings, savedUpdateBody: undefined })).toThrow('SAVED_UPDATE_REQUIRED');
      expect(() => readNegativeConfig({ ...data.bindings, SMOKE_TEXT: 'different' })).toThrow();
      expect(() => readNegativeConfig({ ...data.bindings, SMOKE_MESSAGE_DATE: undefined })).toThrow();
    } finally { await data.cleanup(); }
  });

  it('prepares offline, submits once, verifies failed generation one and one DO send/admission/dispatch', async () => {
    const data = await fixture();
    try {
      const options = { fetchImpl: data.fetchImpl, sleep: async () => {} };
      await operate('--prepare', data.config, options);
      expect(data.calls).toHaveLength(0);
      await expect(operate('--prepare', data.config, options)).rejects.toThrow();
      await operate('--submit-approved', data.config, options);
      await expect(operate('--submit-approved', data.config, options)).rejects.toThrow('FRESH_PREPARE_REQUIRED');
      const proof = await operate('--observe', data.config, options);
      expect(proof).toMatchObject({ outcome: 'pass', failureClass: 'ARTIFACTS_MISSING', admissionCount: 1, dispatchCount: 1,
        attemptCount: 1, terminalAttempts: 1, generation: 1, artifactCount: 0 });
      expect(data.calls.filter(call => new URL(call.url).pathname === '/webhook')).toHaveLength(1);
      expect(data.calls.some(call => new URL(call.url).pathname === '/cron')).toBe(false);
      expect(JSON.stringify(proof)).not.toContain('offline_secret');
      expect(JSON.parse(await readFile(data.config.checkpointFile)).phase).toBe('passed');
    } finally { await data.cleanup(); }
  });

  it('preserves an unknown acknowledgement and forbids another ingress', async () => {
    const data = await fixture();
    try {
      await operate('--prepare', data.config);
      let sends = 0;
      const fetchImpl = (url, options) => {
        if (new URL(url).pathname === '/webhook') { sends += 1; throw new Error('private network details'); }
        return data.fetchImpl(url, options);
      };
      await expect(operate('--submit-approved', data.config, { fetchImpl })).rejects.toThrow('TRANSPORT_TIMEOUT_OR_JSON');
      expect(JSON.parse(await readFile(data.config.checkpointFile)).phase).toBe('submission_unknown');
      await expect(operate('--submit-approved', data.config, { fetchImpl })).rejects.toThrow('FRESH_PREPARE_REQUIRED');
      expect(sends).toBe(1);
      await expect(operate('--observe', data.config, { fetchImpl: data.fetchImpl, sleep: async () => {} })).resolves.toMatchObject({ outcome: 'pass' });
    } finally { await data.cleanup(); }
  });

  it.each(['generation', 'wrongFailure', 'done', 'artifacts', 'twoAttempts', 'twoAdmissions', 'twoDispatches', 'twoSends', 'wrongDestination', 'missingOutput'])('rejects false negative acceptance: %s', async kind => {
    const data = await fixture();
    try {
      if (kind === 'generation') data.status.taskStore.generation = 2;
      if (kind === 'wrongFailure') data.status.taskStore.result.failure.code = 'OTHER';
      if (kind === 'done') data.status.taskStore.status = 'done';
      if (kind === 'artifacts') data.status.artifacts.push({ id: 'unexpected' });
      if (kind === 'twoAttempts') data.status.runs.push(data.status.runs[0]);
      if (kind === 'twoAdmissions') data.journal.push(data.journal[0]);
      if (kind === 'twoDispatches') data.journal.push(data.journal[1]);
      if (kind === 'twoSends') data.deliveries.terminal.attempts = 2;
      if (kind === 'wrongDestination') data.deliveries.terminal.chatId = 124;
      if (kind === 'missingOutput') data.journal[0].record.spec.outputs = [];
      expect(() => verifyNegative(data.status, data.deliveries, data.config, data.journal)).toThrow();
    } finally { await data.cleanup(); }
  });

  it('requires approved unpaused cutover before ingress', async () => {
    const data = await fixture();
    try {
      await operate('--prepare', data.config);
      const fetchImpl = (url, options) => new URL(url).pathname === '/delivery-cutover'
        ? Promise.resolve(Response.json({ ready: true, paused: true, cutoverId: data.config.cutoverId })) : data.fetchImpl(url, options);
      await expect(operate('--submit-approved', data.config, { fetchImpl })).rejects.toThrow('REVIEWED_AUTODELIVERY_REQUIRED');
      expect(data.calls.some(call => new URL(call.url).pathname === '/webhook')).toBe(false);
    } finally { await data.cleanup(); }
  });

  it('preserves first proof and refuses changing provider IDs on readback', async () => {
    const data = await fixture();
    try {
      await operate('--prepare', data.config);
      await operate('--submit-approved', data.config, { fetchImpl: data.fetchImpl });
      let reads = 0;
      const fetchImpl = (url, options) => {
        if (new URL(url).pathname.startsWith('/deliveries/') && ++reads === 2) {
          return Promise.resolve(Response.json({ ...data.deliveries, terminal: { ...data.deliveries.terminal, providerMessageId: 1401 } }));
        }
        return data.fetchImpl(url, options);
      };
      await expect(operate('--observe', data.config, { fetchImpl, sleep: async () => {} })).rejects.toThrow('READBACK_PROOF_CHANGED');
      const checkpoint = JSON.parse(await readFile(data.config.checkpointFile));
      expect(checkpoint.phase).toBe('observed');
      expect(checkpoint.proof.providerMessageId).toBe('1400');
    } finally { await data.cleanup(); }
  });

  it('never reports pass without a private complete journal snapshot', async () => {
    const data = await fixture();
    try {
      await operate('--prepare', data.config);
      await operate('--submit-approved', data.config, { fetchImpl: data.fetchImpl });
      await expect(operate('--observe', { ...data.config, admissionFile: undefined }, { fetchImpl: data.fetchImpl }))
        .rejects.toThrow('PRIVATE_ADMISSION_SNAPSHOT_REQUIRED');
    } finally { await data.cleanup(); }
  });

  it('bounds response reads and cancels oversized bodies without submitting', async () => {
    const data = await fixture();
    try {
      await operate('--prepare', data.config);
      let cancelled = false;
      const fetchImpl = async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(262145)); },
        cancel() { cancelled = true; },
      }));
      await expect(operate('--submit-approved', data.config, { fetchImpl })).rejects.toThrow('HTTP_BODY_TOO_LARGE');
      expect(cancelled).toBe(true);
      expect(JSON.parse(await readFile(data.config.checkpointFile)).phase).toBe('prepared');
    } finally { await data.cleanup(); }
  });
});
