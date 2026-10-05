import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadExistingUxConfig, operateExistingUx, readExistingUxConfig, verifyExistingUxDelivery }
  from '../scripts/integration/telegram-existing-ux-acceptance.mjs';

async function fixture(expectedRunCount = 1) {
  const directory = await mkdtemp(join(tmpdir(), 'existing-ux-operator-offline-'));
  const raw = { fixture: true, caseId: 'offline-existing-ux', gatewayUrl: 'https://gateway.example.invalid',
    controlPlaneUrl: 'https://cp.example.invalid', principalId: 'offline-principal', profileId: 'offline-profile',
    principalSignature: 'a'.repeat(64), apiKey: 'offline-cp-key', webhookSecret: 'offline-webhook-secret',
    botUsername: 'offline_fixture_bot', chatId: 123, userId: 456, threadId: null,
    messages: [{ updateId: 901010080, messageId: 901010080, date: 1791190800,
      text: '[Integration fixture offline-existing-ux]\nRead category,amount\nfood,100' },
    { updateId: 901010081, messageId: 901010081, date: 1791190800,
      text: '[Integration fixture offline-existing-ux]\nAdd food,50 and travel,275; write the declared output.' }],
    callbackUpdateId: 901010082, callbackId: 'offline-frozen-callback-82', checkpointFile: join(directory, 'checkpoint.json'),
    approved: 'yes', expectedRunCount, pollIntervalMs: 1 };
  const config = readExistingUxConfig(raw);
  const calls = [];
  let appended = false;
  let launched = false;
  const collector = { busy: false, buf: [], launching: [], retryBatch: [], collectorMsgId: null,
    collectorDelivery: null, stopped: null, debounceExpiresAt: Date.now() + 180000 };
  const receipt = { userTaskId: config.taskId, requestId: config.requestId, profileId: config.profileId, durable: true };
  const status = { taskStore: { id: config.taskId, profile_id: config.profileId,
    generation: 1, status: 'done', stage: 'finished', result: { answer: 'Offline fixture output.' } },
  runs: expectedRunCount ? [{ id: 'attempt-offline', session_id: 'run-offline-canonical', generation: 1, status: 'done' }] : [] };
  const deliveries = { receipt: null, terminal: { userTaskId: config.taskId, deliveryId: `terminal:${config.taskId}:g1`,
    generation: 1, status: 'sent', attempts: 1, providerMessageId: 1400, chatId: config.chatId,
    threadId: null, legacyStatus: null } };
  const fetchImpl = async (url, options) => {
    const target = new URL(url);
    calls.push({ url, ...options });
    expect(options.redirect).toBe('error');
    expect(options.signal).toBeDefined();
    expect(['/health', '/collector-state', '/webhook', '/status', '/receipt', `/deliveries/${config.taskId}`]).toContain(target.pathname);
    if (target.hostname === 'gateway.example.invalid') {
      expect(options.headers['x-telegram-bot-api-secret-token']).toBe(raw.webhookSecret);
      expect(options.headers.authorization).toBeUndefined();
      expect(options.headers['x-principal-sig']).toBeUndefined();
    } else {
      expect(target.hostname).toBe('cp.example.invalid');
      expect(options.headers.authorization).toBe(`Bearer ${raw.apiKey}`);
      expect(options.headers['x-principal-sig']).toBe(raw.principalSignature);
      expect(options.headers['x-telegram-bot-api-secret-token']).toBeUndefined();
    }
    if (target.pathname === '/health') return Response.json({ status: 'ok', mode: 'existing-ux-control-plane', acceptance: 'pending' });
    if (target.pathname === '/collector-state') {
      expect(target.searchParams.get('chatId')).toBe(String(config.chatId));
      return Response.json(collector);
    }
    if (target.pathname === '/receipt') {
      expect(JSON.parse(options.body)).toEqual({ taskId: config.taskId });
      return Response.json(receipt);
    }
    if (target.pathname === '/status') {
      expect(JSON.parse(options.body)).toEqual({ taskId: config.taskId });
      return launched ? Response.json(status) : Response.json({ name: 'TaskNotFoundError', error: `task not found: ${config.taskId}` }, { status: 404 });
    }
    if (target.pathname === '/webhook') {
      const checkpoint = JSON.parse(await readFile(config.checkpointFile, 'utf8'));
      const update = JSON.parse(options.body);
      if (update.message) {
        expect(checkpoint.phase).toBe('append_unknown');
        expect(checkpoint.updateBodies).toContain(options.body);
        appended = true;
        collector.buf.push({ messageId: update.message.message_id, hasText: true, mediaPending: false });
        collector.collectorMsgId = 1370;
        collector.collectorDelivery = { state: 'sent', messageId: 1370 };
        return Response.json({ ok: true, buffered: collector.buf.length });
      }
      expect(checkpoint.phase).toBe('launch_unknown');
      expect(checkpoint.callbackBody).toBe(options.body);
      expect(checkpoint.prelaunch.zeroAdmission).toBe(true);
      expect(update.callback_query.message.message_id).toBe(1370);
      expect(update.update_id).toBe(config.callbackUpdateId);
      expect(update.callback_query.id).toBe(config.callbackId);
      expect(update.callback_query.data).toBe('intake_run');
      launched = true;
      return Response.json({ ok: true });
    }
    return Response.json(deliveries);
  };
  return { raw, config, calls, fetchImpl, collector, status, deliveries, receipt, directory,
    get appended() { return appended; }, get launched() { return launched; },
    options: { fetchImpl, sleep: async () => {} },
    cleanup: () => rm(directory, { recursive: true, force: true }) };
}

async function ready(data) {
  await operateExistingUx('--prepare', data.config, data.options);
  await operateExistingUx('--append-approved', data.config, data.options);
  await operateExistingUx('--observe-collector', data.config, data.options);
}

describe('NEW existing-UX operator harness, offline fixtures only', () => {
  it('requires the frozen user goal result rather than any nonempty answer', async () => {
    const data = await fixture();
    try {
      const config = readExistingUxConfig({ ...data.raw, expectedAnswerSubstring: 'fixture output.' });
      expect(config.fingerprint).not.toBe(data.config.fingerprint);
      expect(verifyExistingUxDelivery(data.status, data.deliveries, config, data.receipt).goalResultMatched).toBe(true);
      data.status.taskStore.result.answer = 'Unrelated successful response.';
      expect(() => verifyExistingUxDelivery(data.status, data.deliveries, config, data.receipt)).toThrow('GOAL_RESULT_MISMATCH');
      expect(() => readExistingUxConfig({ ...data.raw, expectedAnswerSubstring: '' })).toThrow('BOUNDED_GOAL_EXPECTATION_REQUIRED');
      expect(() => readExistingUxConfig({ ...data.raw, expectedAnswerSubstring: 'x'.repeat(1001) })).toThrow('BOUNDED_GOAL_EXPECTATION_REQUIRED');
      expect(readExistingUxConfig(data.raw).fingerprint).toBe(data.config.fingerprint);
    } finally { await data.cleanup(); }
  });

  it.each([0, 1])('freezes identity, uses the actual collector ID, and observes stable delivery with %i engine attempts', async count => {
    const data = await fixture(count);
    try {
      await operateExistingUx('--prepare', data.config, data.options);
      expect(data.calls).toHaveLength(0);
      expect((await stat(data.config.checkpointFile)).mode & 0o777).toBe(0o600);
      await expect(operateExistingUx('--prepare', data.config, data.options)).rejects.toThrow();
      await operateExistingUx('--append-approved', data.config, data.options);
      await operateExistingUx('--observe-collector', data.config, data.options);
      await operateExistingUx('--launch-approved', data.config, data.options);
      const proof = await operateExistingUx('--observe', data.config, data.options);
      expect(proof).toMatchObject({ outcome: 'pass', taskId: data.config.taskId, scopedZeroAdmission: true,
        generation: 1, attemptCount: count, terminalAttempts: 1, providerMessageId: 1400 });
      expect(data.calls.filter(call => new URL(call.url).pathname === '/webhook')).toHaveLength(3);
      expect(data.calls.filter(call => new URL(call.url).pathname.startsWith('/deliveries/'))).toHaveLength(2);
      for (const privateValue of [data.raw.webhookSecret, data.raw.apiKey, data.raw.botUsername, data.raw.gatewayUrl, data.raw.controlPlaneUrl]) {
        expect(JSON.stringify(proof)).not.toContain(privateValue);
      }
      expect(JSON.stringify(proof)).not.toContain('chatId');
      expect(JSON.parse(await readFile(data.config.checkpointFile, 'utf8')).phase).toBe('passed');
      await expect(operateExistingUx('--launch-approved', data.config, data.options)).rejects.toThrow('APPROVED_COLLECTOR_CHECKPOINT_REQUIRED');
    } finally { await data.cleanup(); }
  });

  it('preserves lost append ACK and never blindly repeats or continues the ingress sequence', async () => {
    const data = await fixture();
    try {
      await operateExistingUx('--prepare', data.config, data.options);
      const fetchImpl = async (url, options) => {
        const result = await data.fetchImpl(url, options);
        if (new URL(url).pathname === '/webhook') throw new TypeError('private endpoint details must not escape');
        return result;
      };
      await expect(operateExistingUx('--append-approved', data.config, { fetchImpl })).rejects.toThrow('TRANSPORT_OR_JSON_UNKNOWN');
      expect(data.calls.filter(call => new URL(call.url).pathname === '/webhook')).toHaveLength(1);
      expect(JSON.parse(await readFile(data.config.checkpointFile, 'utf8')).phase).toBe('append_unknown');
      expect(JSON.parse(await readFile(data.config.checkpointFile, 'utf8')).failure).toMatchObject({
        code: 'TRANSPORT_OR_JSON_UNKNOWN', boundary: 'gateway:POST /webhook', phase: 'append_unknown',
      });
      await expect(operateExistingUx('--append-approved', data.config, data.options)).rejects.toThrow('FRESH_PREPARE_REQUIRED');
      await expect(operateExistingUx('--observe-collector', data.config, data.options)).rejects.toThrow('EXACT_BUFFER_REQUIRED');
      expect(data.calls.filter(call => new URL(call.url).pathname === '/webhook')).toHaveLength(1);
    } finally { await data.cleanup(); }
  });

  it('reconciles lost callback ACK read-only with the same task, never replays the callback', async () => {
    const data = await fixture();
    try {
      await ready(data);
      const fetchImpl = async (url, options) => {
        const result = await data.fetchImpl(url, options);
        if (new URL(url).pathname === '/webhook') throw new Error('private transport diagnostics');
        return result;
      };
      await expect(operateExistingUx('--launch-approved', data.config, { fetchImpl })).rejects.toThrow('TRANSPORT_OR_JSON_UNKNOWN');
      expect(JSON.parse(await readFile(data.config.checkpointFile, 'utf8')).phase).toBe('launch_unknown');
      await expect(operateExistingUx('--launch-approved', data.config, data.options)).rejects.toThrow('APPROVED_COLLECTOR_CHECKPOINT_REQUIRED');
      const before = data.calls.filter(call => new URL(call.url).pathname === '/webhook').length;
      await expect(operateExistingUx('--observe', data.config, data.options)).resolves.toMatchObject({ outcome: 'pass' });
      expect(data.calls.filter(call => new URL(call.url).pathname === '/webhook')).toHaveLength(before);
    } finally { await data.cleanup(); }
  });

  it.each(['oldGateway', 'busy', 'alreadyAdmitted', 'collectorUnknown', 'wrongProviderId'])('fails closed on %s before a launch callback', async kind => {
    const data = await fixture();
    try {
      if (kind === 'oldGateway') {
        await operateExistingUx('--prepare', data.config, data.options);
        await expect(operateExistingUx('--append-approved', data.config, { fetchImpl: async () =>
          Response.json({ status: 'ok', mode: 'direct' }) })).rejects.toThrow('NEW_EXISTING_UX_GATEWAY_REQUIRED');
      } else {
        await ready(data);
        if (kind === 'busy') data.collector.busy = true;
        if (kind === 'collectorUnknown') data.collector.collectorDelivery.state = 'unknown';
        if (kind === 'wrongProviderId') data.collector.collectorDelivery.messageId = 9999;
        const fetchImpl = async (url, options) => kind === 'alreadyAdmitted' && new URL(url).pathname === '/status'
          ? Response.json(data.status) : data.fetchImpl(url, options);
        await expect(operateExistingUx('--launch-approved', data.config, { fetchImpl })).rejects.toThrow();
      }
      expect(data.launched).toBe(false);
    } finally { await data.cleanup(); }
  });

  it.each(['frozenText', 'frozenDate', 'frozenCallback', 'credentials'])('refuses changed checkpoint identity: %s', async kind => {
    const data = await fixture();
    try {
      await operateExistingUx('--prepare', data.config, data.options);
      const changed = structuredClone(data.raw);
      if (kind === 'frozenText') changed.messages[0].text += '\nchanged';
      if (kind === 'frozenDate') changed.messages[0].date += 1;
      if (kind === 'frozenCallback') changed.callbackId += '-new';
      if (kind === 'credentials') changed.apiKey += '-new';
      await expect(operateExistingUx('--append-approved', readExistingUxConfig(changed), data.options)).rejects.toThrow('FROZEN_IDENTITY_MISMATCH');
      expect(data.calls).toHaveLength(0);
    } finally { await data.cleanup(); }
  });

  it.each(['twoAttempts', 'twoSends', 'wrongScope', 'wrongDestination', 'noAnswer', 'legacyReceipt', 'unknownDelivery'])('rejects false PASS evidence: %s', async kind => {
    const data = await fixture();
    try {
      if (kind === 'twoAttempts') data.status.runs.push(data.status.runs[0]);
      if (kind === 'twoSends') data.deliveries.terminal.attempts = 2;
      if (kind === 'wrongScope') data.receipt.requestId = 'foreign-request';
      if (kind === 'wrongDestination') data.deliveries.terminal.chatId += 1;
      if (kind === 'noAnswer') data.status.taskStore.result.answer = '';
      if (kind === 'legacyReceipt') data.deliveries.receipt = { status: 'sent' };
      if (kind === 'unknownDelivery') data.deliveries.terminal.status = 'unknown';
      expect(() => verifyExistingUxDelivery(data.status, data.deliveries, data.config, data.receipt)).toThrow();
    } finally { await data.cleanup(); }
  });

  it('requires private bindings, exclusive operation lock and refuses symlink checkpoints', async () => {
    const data = await fixture();
    try {
      const bindingsFile = join(data.directory, 'bindings.json');
      await writeFile(bindingsFile, JSON.stringify(data.raw), { mode: 0o600 });
      expect((await loadExistingUxConfig(bindingsFile)).taskId).toBe(data.config.taskId);
      await writeFile(data.config.checkpointFile + '.lock', '', { mode: 0o600 });
      await expect(operateExistingUx('--prepare', data.config, data.options)).rejects.toThrow();
      await rm(data.config.checkpointFile + '.lock');
      await symlink(bindingsFile, data.config.checkpointFile);
      await expect(operateExistingUx('--prepare', data.config, data.options)).rejects.toThrow();
      expect(data.calls).toHaveLength(0);
    } finally { await data.cleanup(); }
  });

  it('bounds response reads and keeps transport errors sanitized', async () => {
    const data = await fixture();
    try {
      await operateExistingUx('--prepare', data.config, data.options);
      await expect(operateExistingUx('--append-approved', data.config, { fetchImpl: async () =>
        new Response('x'.repeat(262145)) })).rejects.toThrow('HTTP_BODY_TOO_LARGE');
      await expect(operateExistingUx('--append-approved', data.config, { fetchImpl: async () => {
        throw new Error(data.raw.webhookSecret + data.raw.gatewayUrl);
      } })).rejects.toThrow('TRANSPORT_OR_JSON_UNKNOWN');
      expect(data.calls).toHaveLength(0);
      expect(data.config.requestTimeoutMs).toBe(60000);
      expect(data.config.overallTimeoutMs).toBe(900000);
    } finally { await data.cleanup(); }
  });
});
