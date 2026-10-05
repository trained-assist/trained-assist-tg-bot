import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBindings, readConfig, readLiveConfig, runSmoke, serializeUpdate } from '../scripts/integration/telegram-v1-smoke.mjs';

const bindings = {
  GATEWAY_URL: 'https://gateway.example.invalid',
  CONTROL_PLANE_URL: 'https://cp.example.invalid',
  CONTROL_PLANE_PRINCIPAL: 'offline',
  CONTROL_PLANE_PROFILE: 'offline',
  CONTROL_PLANE_PRINCIPAL_SIGNATURE: '1'.repeat(64),
  TELEGRAM_WEBHOOK_SECRET: 'offline_secret',
  TG_SANDBOX_BOT_USERNAME: 'probability_cat_bot',
  TG_SLICE_ALLOWED_CHATS: '123',
  TEST_CHAT_ID: 123,
  TEST_USER_ID: 123,
};

describe('Telegram integration smoke request deadline', () => {
  it('allows the synchronous ingress boundary sixty seconds by default', () => {
    expect(readConfig(bindings).requestTimeoutMs).toBe(60_000);
  });

  it('preserves explicit bounded overrides', () => {
    expect(readConfig({ ...bindings, SMOKE_REQUEST_TIMEOUT_MS: 15_000 }).requestTimeoutMs).toBe(15_000);
    expect(() => readConfig({ ...bindings, SMOKE_REQUEST_TIMEOUT_MS: 60_001 })).toThrow();
  });
});

describe('Telegram integration smoke Runner identity evidence', () => {
  const taskId = 'ut-offline-native';
  const attemptId = `routing-run:${taskId}:1`;
  const runnerId = '026cf629-219c-445f-92b1-063212bcf893';

  async function smoke(runs, replayRuns = runs) {
    const config = readConfig(bindings);
    let ingressCalls = 0;
    let statusCalls = 0;
    return runSmoke(config, {
      emit: () => {},
      fetchImpl: async url => {
        let payload;
        if (url.endsWith('/health')) payload = { status: 'ok', bot: config.username, mode: 'direct' };
        else if (url.endsWith('/webhook')) payload = { ok: true, userTaskId: taskId, duplicate: ++ingressCalls > 1 };
        else if (url.endsWith('/status')) payload = {
          taskStore: { id: taskId, profile_id: config.profile, status: 'done', generation: 1, result: { answer: 'offline answer' } },
          runs: ++statusCalls > 1 ? replayRuns : runs,
        };
        else if (url.includes('/deliveries/')) payload = { deliveries: [
          { deliveryId: 'receipt:offline', userTaskId: taskId, chatId: config.chatId, threadId: null,
            status: 'sent', attempts: 1, providerMessageId: 1 },
          { deliveryId: `terminal:${taskId}:g1`, userTaskId: taskId, chatId: config.chatId, threadId: null,
            status: 'sent', attempts: 1, providerMessageId: 2 },
        ] };
        else if (url.endsWith('/cron')) payload = { reconciled: true };
        else throw new Error('Unexpected offline request');
        return { ok: true, json: async () => payload };
      },
    });
  }

  it.each([runnerId, `run_${runnerId}`])('reports attached Runner ID verbatim: %s', async sessionId => {
    const result = await smoke([{ id: attemptId, session_id: sessionId }]);
    expect(result).toMatchObject({ outcome: 'pass', runIds: [sessionId], orchestrationAttemptIds: [attemptId] });
  });

  it.each([null, undefined])('does not invent Runner IDs for unattached attempts: %s', async sessionId => {
    const result = await smoke([{ id: attemptId, session_id: sessionId }]);
    expect(result).toMatchObject({ outcome: 'pass', runIds: [], orchestrationAttemptIds: [attemptId] });
  });

  it('does not infer Runner identity from a UUID-shaped attempt ID', async () => {
    expect(await smoke([{ id: runnerId }])).toMatchObject({ outcome: 'pass', runIds: [], orchestrationAttemptIds: [runnerId] });
  });

  it('preserves quick replies with no attempts', async () => {
    expect(await smoke([])).toMatchObject({ outcome: 'pass', runIds: [], orchestrationAttemptIds: [] });
  });

  it.each(['', 'unsafe/value', 12])('refuses malformed attached Runner identity: %s', async sessionId => {
    expect(await smoke([{ id: attemptId, session_id: sessionId }])).toMatchObject({ outcome: 'fail', reason: 'Invalid Runner runId' });
  });

  it('fails replay if the attached Runner changes with the same attempt ID', async () => {
    const result = await smoke([{ id: attemptId, session_id: runnerId }], [{ id: attemptId, session_id: `run_${runnerId}` }]);
    expect(result).toMatchObject({ outcome: 'fail', reason: 'Reconciliation replay changed task or runs' });
  });
});

describe('Telegram integration smoke stable live identity', () => {
  const stableBindings = { ...bindings, SMOKE_UPDATE_ID: 901010061, SMOKE_MESSAGE_ID: 901010061, SMOKE_MESSAGE_DATE: 1791180000 };

  it('requires both explicitly reserved IDs without changing library compatibility', () => {
    expect(() => readLiveConfig(bindings)).toThrow('Missing SMOKE_UPDATE_ID');
    expect(() => readLiveConfig({ ...bindings, SMOKE_UPDATE_ID: 901010061 })).toThrow('Missing SMOKE_MESSAGE_ID');
    expect(readConfig(bindings).updateId).toBeGreaterThan(0);
    expect(readLiveConfig(stableBindings)).toMatchObject({ updateId: 901010061, messageId: 901010061 });
  });

  it.each(['', ' ', 0, -1, 1.5, 2147483648, 'invalid'])('rejects invalid explicit IDs: %s', value => {
    expect(() => readLiveConfig({ ...stableBindings, SMOKE_UPDATE_ID: value })).toThrow();
    expect(() => readLiveConfig({ ...stableBindings, SMOKE_MESSAGE_ID: value })).toThrow();
  });

  it('blocks the live CLI before network when either ID is absent', () => {
    const script = fileURLToPath(new URL('../scripts/integration/telegram-v1-smoke.mjs', import.meta.url));
    for (const supplied of [{}, { SMOKE_UPDATE_ID: '901010061' },
      { SMOKE_UPDATE_ID: '901010061', SMOKE_MESSAGE_ID: '901010061' }]) {
      const result = spawnSync(process.execPath, [script], { env: supplied, encoding: 'utf8', timeout: 5000 });
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'blocked', liveRun: 'not_started' });
    }
  });

  it('pins the serialized body across clock changes', () => {
    const config = readLiveConfig(stableBindings);
    expect(serializeUpdate(config, 1)).toBe(serializeUpdate(config, 2));
    expect(JSON.parse(serializeUpdate(config)).message.date).toBe(1791180000);
    expect(readConfig(bindings).messageDate).toBeNull();
  });

  it.each(['', ' ', 0, -1, 1.5, 2147483648, 'invalid'])('rejects invalid live message date: %s', value => {
    expect(() => readLiveConfig({ ...stableBindings, SMOKE_MESSAGE_DATE: value })).toThrow();
  });

  it('returns the original saved bytes and rejects changed text, date or destination', () => {
    const savedUpdateBody = JSON.stringify(JSON.parse(serializeUpdate(readLiveConfig(stableBindings))), null, 2) + '\n';
    const config = readLiveConfig({ ...stableBindings, savedUpdateBody });
    expect(serializeUpdate(config)).toBe(savedUpdateBody);
    for (const changed of [{ SMOKE_TEXT: 'changed' }, { SMOKE_MESSAGE_DATE: 1791180001 },
      { TEST_USER_ID: 124 }, { TEST_CHAT_ID: 124, TG_SLICE_ALLOWED_CHATS: '123,124' },
      { SMOKE_UPDATE_ID: 901010062 }, { SMOKE_MESSAGE_ID: 901010062 }]) {
      expect(() => readLiveConfig({ ...stableBindings, savedUpdateBody, ...changed })).toThrow('Saved update does not match');
    }
  });

  it('loads only a private bounded saved update file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tg-smoke-offline-'));
    const file = join(directory, 'update.json');
    try {
      const body = serializeUpdate(readLiveConfig(stableBindings));
      await writeFile(file, body, { mode: 0o600 });
      const loaded = await loadBindings({ ...stableBindings, INTEGRATION_UPDATE_FILE: file });
      expect(serializeUpdate(readLiveConfig(loaded))).toBe(body);
      await writeFile(file, 'invalid');
      await expect(loadBindings({ INTEGRATION_UPDATE_FILE: file })).rejects.toThrow('Cannot read private');
      await writeFile(file, ' '.repeat(65537));
      await expect(loadBindings({ INTEGRATION_UPDATE_FILE: file })).rejects.toThrow('at most 65536');
      const publicFile = join(directory, 'public.json');
      await writeFile(publicFile, body, { mode: 0o644 });
      await expect(loadBindings({ INTEGRATION_UPDATE_FILE: publicFile })).rejects.toThrow('must be private');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses a changed saved body before even health HTTP', async () => {
    const config = readLiveConfig(stableBindings);
    config.savedUpdateBody = serializeUpdate(config);
    config.text = 'changed after preflight';
    const fetchImpl = vi.fn();
    const evidence = await runSmoke(config, { fetchImpl, emit: () => {} });
    expect(evidence.outcome).toBe('blocked');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('bounds requests by the remaining overall budget', async () => {
    const config = { ...readLiveConfig(stableBindings), timeoutMs: 1000 };
    const requests = [];
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      const evidence = await runSmoke(config, {
        emit: () => {},
        fetchImpl: async (_url, options) => {
          requests.push(options);
          return { ok: true, json: async () => ({ status: 'unavailable' }) };
        },
      });
      expect(evidence.outcome).toBe('fail');
      expect(requests).toHaveLength(1);
      expect(requests[0].redirect).toBe('error');
      expect(requests[0].signal).toBeInstanceOf(AbortSignal);
      expect(timeout.mock.calls[0][0]).toBeGreaterThan(0);
      expect(timeout.mock.calls[0][0]).toBeLessThanOrEqual(1000);
    } finally {
      timeout.mockRestore();
    }
  });
});
