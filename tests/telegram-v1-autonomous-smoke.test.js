import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBindings, readConfig, readLiveConfig, runSmoke, serializeUpdate } from '../scripts/integration/telegram-v1-smoke.mjs';

const bindings = {
  GATEWAY_URL: 'https://gateway.example.invalid', CONTROL_PLANE_URL: 'https://cp.example.invalid',
  CONTROL_PLANE_PRINCIPAL: 'offline', CONTROL_PLANE_PROFILE: 'offline',
  CONTROL_PLANE_PRINCIPAL_SIGNATURE: '1'.repeat(64), TELEGRAM_WEBHOOK_SECRET: 'offline_secret',
  TG_SANDBOX_BOT_USERNAME: 'sandbox_test_bot', TG_SANDBOX_BOT_TOKEN: 'synthetic-token',
  TG_SLICE_ALLOWED_CHATS: '123', TEST_CHAT_ID: 123, TEST_USER_ID: 123,
  SMOKE_UPDATE_ID: 901010070, SMOKE_MESSAGE_ID: 901010070, SMOKE_MESSAGE_DATE: 1791180000,
  SMOKE_POLL_INTERVAL_MS: 100,
};

async function fixture(mode = 'autonomous') {
  const directory = await mkdtemp(join(tmpdir(), 'tg-autonomous-offline-'));
  const file = join(directory, 'update.json');
  const body = serializeUpdate(readLiveConfig(bindings));
  await writeFile(file, body, { flag: 'wx', mode: 0o600 });
  const loaded = await loadBindings({ ...bindings, INTEGRATION_UPDATE_FILE: file, SMOKE_RECONCILIATION_MODE: mode });
  const config = readLiveConfig(loaded);
  const calls = [];
  let posts = 0;
  const status = { taskStore: { id: 'offline-task', status: 'done', generation: 1, profile_id: 'offline', result: { answer: 'Offline fixture answer' } }, runs: [] };
  const deliveries = { receipt: { deliveryId: 'receipt:offline-request', userTaskId: 'offline-task', status: 'sent', attempts: 1,
    providerMessageId: 100, chatId: 123, threadId: null }, terminal: { deliveryId: 'terminal:offline-task:g1',
    userTaskId: 'offline-task', status: 'sent', attempts: 1, providerMessageId: 101, chatId: 123, threadId: null } };
  const fetchImpl = async (url, options) => {
    const address = new URL(url);
    calls.push({ origin: address.origin, path: address.pathname, ...options });
    if (address.origin === 'https://api.telegram.org') return Response.json({ ok: true, result: { is_bot: true, username: config.username } });
    if (address.pathname === '/health') return Response.json({ status: 'ok', bot: config.username, mode: 'direct' });
    if (address.pathname === '/webhook') return Response.json({ ok: true, duplicate: posts++ > 0, userTaskId: 'offline-task' });
    if (address.pathname === '/status') return Response.json(status);
    if (address.pathname === '/cron') return Response.json({ reconciled: true });
    if (address.pathname === '/deliveries/offline-task') return Response.json(deliveries);
    throw new Error('Unexpected fixture request');
  };
  return { config, calls, status, deliveries, fetchImpl, file, body, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

describe('autonomous Telegram smoke, offline fixtures only', () => {
  it('reads natural delivery without manual cron or provider fetch despite a token', async () => {
    const data = await fixture();
    try {
      let deliveryReads = 0;
      const fetchImpl = (url, options) => {
        if (new URL(url).pathname.startsWith('/deliveries/') && ++deliveryReads === 1) {
          data.calls.push({ origin: new URL(url).origin, path: new URL(url).pathname, ...options });
          return Promise.resolve(Response.json({ ...data.deliveries, terminal: { ...data.deliveries.terminal, status: 'pending', attempts: 0, providerMessageId: null } }));
        }
        return data.fetchImpl(url, options);
      };
      const proof = await runSmoke(data.config, { fetchImpl, emit: () => {} });
      expect(proof).toMatchObject({ outcome: 'pass', duplicate: true, botIdentity: 'gateway_health_only',
        reconciliationMode: 'autonomous', reconciliationReplay: 'not_invoked', deliveryReadback: 'unchanged',
        delivery: 'bot_api_accepted', providerMessageId: '101', runIds: [], orchestrationAttemptIds: [] });
      expect(deliveryReads).toBe(3);
      expect(data.calls.filter(call => call.path === '/cron')).toHaveLength(0);
      expect(data.calls.filter(call => call.origin === 'https://api.telegram.org')).toHaveLength(0);
      const posts = data.calls.filter(call => call.path === '/webhook');
      expect(posts).toHaveLength(2);
      expect(posts.map(call => call.body)).toEqual([data.body, data.body]);
      expect(await readFile(data.file, 'utf8')).toBe(data.body);
    } finally { await data.cleanup(); }
  });

  it('preserves manual defaults, cron replay and optional getMe', async () => {
    const data = await fixture('manual');
    try {
      expect(readConfig(bindings).reconciliationMode).toBe('manual');
      const proof = await runSmoke(data.config, { fetchImpl: data.fetchImpl, emit: () => {} });
      expect(proof).toMatchObject({ outcome: 'pass', botIdentity: 'getMe_verified', reconciliationReplay: 'unchanged' });
      expect(data.calls.filter(call => call.path === '/cron')).toHaveLength(2);
      expect(data.calls.filter(call => call.origin === 'https://api.telegram.org')).toHaveLength(1);
    } finally { await data.cleanup(); }
  });

  it.each(['unknown', '', 'AUTONOMOUS', ' autonomous '])('refuses unknown mode %s before HTTP', async mode => {
    expect(() => readConfig({ ...bindings, SMOKE_RECONCILIATION_MODE: mode })).toThrow('Invalid SMOKE_RECONCILIATION_MODE');
    const calls = [];
    const proof = await runSmoke({ ...readConfig(bindings), reconciliationMode: mode }, {
      fetchImpl: async () => { calls.push(true); throw new Error('Network forbidden'); }, emit: () => {},
    });
    expect(proof.outcome).toBe('blocked');
    expect(calls).toHaveLength(0);
  });

  it('requires a prepared private update and pinned live identity', async () => {
    expect(() => readConfig({ ...bindings, SMOKE_RECONCILIATION_MODE: 'autonomous' })).toThrow('Missing INTEGRATION_UPDATE_FILE');
    expect(() => readConfig({ ...bindings, INTEGRATION_UPDATE_FILE: '/private/update.json', SMOKE_RECONCILIATION_MODE: 'autonomous' }))
      .toThrow('prepared private saved update');
    const data = await fixture();
    try {
      const loaded = await loadBindings({ ...bindings, INTEGRATION_UPDATE_FILE: data.file, SMOKE_RECONCILIATION_MODE: 'autonomous' });
      for (const key of ['SMOKE_UPDATE_ID', 'SMOKE_MESSAGE_ID', 'SMOKE_MESSAGE_DATE']) {
        expect(() => readConfig({ ...loaded, [key]: undefined })).toThrow(`Missing ${key}`);
      }
      const publicFile = join(data.file, '..', 'public.json');
      await writeFile(publicFile, data.body, { mode: 0o644 });
      await expect(loadBindings({ INTEGRATION_UPDATE_FILE: publicFile })).rejects.toThrow('must be private');
    } finally { await data.cleanup(); }
  });

  it('preserves run-ID distinction and refuses changed delivery readback', async () => {
    const data = await fixture();
    try {
      data.status.runs = [{ id: 'cp-attempt-one', session_id: 'run_one' }];
      let deliveryReads = 0;
      const fetchImpl = (url, options) => {
        if (new URL(url).pathname.startsWith('/deliveries/') && ++deliveryReads === 2) {
          return Promise.resolve(Response.json({ ...data.deliveries, terminal: { ...data.deliveries.terminal, providerMessageId: 102 } }));
        }
        return data.fetchImpl(url, options);
      };
      const proof = await runSmoke(data.config, { fetchImpl, emit: () => {} });
      expect(proof).toMatchObject({ outcome: 'fail', runIds: ['run_one'], orchestrationAttemptIds: ['cp-attempt-one'] });
      expect(proof.reason).toContain('changed delivery evidence');
      expect(data.calls.some(call => call.path === '/cron' || call.origin === 'https://api.telegram.org')).toBe(false);
    } finally { await data.cleanup(); }
  });

  it('does not retry an unknown acknowledgement or replace its saved bytes', async () => {
    const data = await fixture();
    try {
      let posts = 0;
      const fetchImpl = (url, options) => {
        if (new URL(url).pathname === '/webhook') { posts += 1; throw new TypeError('Private network details'); }
        return data.fetchImpl(url, options);
      };
      const proof = await runSmoke(data.config, { fetchImpl, emit: () => {} });
      expect(proof.outcome).toBe('fail');
      expect(posts).toBe(1);
      expect(await readFile(data.file, 'utf8')).toBe(data.body);
      expect(data.calls.some(call => call.path === '/cron' || call.origin === 'https://api.telegram.org')).toBe(false);
    } finally { await data.cleanup(); }
  });
});
