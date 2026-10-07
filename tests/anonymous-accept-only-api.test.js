import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSync } from 'esbuild';
import { createFetchMock, Miniflare } from 'miniflare';
import gateway from '../src/sandbox-tg/existing-ux.js';
import { SandboxAcceptOnlyStore } from '../src/sandbox-tg/accept-only.js';

class MemoryStorage {
  values = new Map();
  alarmAt = null;
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async delete(key) { return this.values.delete(key); }
  async list({ prefix = '' } = {}) {
    return new Map([...this.values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value)]));
  }
  async transaction(callback) {
    const snapshot = new MemoryStorage();
    snapshot.values = structuredClone(this.values);
    const result = await callback(snapshot);
    this.values = snapshot.values;
    return result;
  }
  async getAlarm() { return this.alarmAt; }
  async setAlarm(at) { this.alarmAt = at; }
  async deleteAlarm() { this.alarmAt = null; }
}

function makeEnv(overrides = {}) {
  const storage = new MemoryStorage();
  const store = new SandboxAcceptOnlyStore({ storage });
  const internalRequests = [];
  const namespace = {
    get: vi.fn(() => ({ fetch: (request, init) => {
      const internalRequest = request instanceof Request ? request : new Request(request, init);
      internalRequests.push(internalRequest.clone());
      return store.fetch(internalRequest);
    } })),
    idFromName: vi.fn(name => name),
  };
  const env = {
    TG_ACCEPT_ONLY_ENABLED: 'true', TG_ACCEPT_ONLY_ENVIRONMENT: 'sandbox', TG_ACCEPT_ONLY_MODE: 'accept-only',
    TG_SANDBOX_BOT_USERNAME: 'probability_cat_bot', SANDBOX_ACCEPT_ONLY: namespace,
    TG_SANDBOX_BOT_TOKEN: 'fixture-only', TELEGRAM_WEBHOOK_SECRET: 'fixture-only',
    CONTROL_PLANE_URL: 'https://cp-sandbox.invalid', CONTROL_PLANE_PRINCIPAL: 'fixture-principal', CONTROL_PLANE_PROFILE: 'fixture-profile',
    CONTROL_PLANE_SERVICE: { fetch: vi.fn(() => { throw new Error('CP must not be called'); }) },
    RUNNER: { fetch: vi.fn(() => { throw new Error('Runner must not be called'); }) },
    ...overrides,
  };
  return { env, storage, store, namespace, internalRequests };
}

const post = (env, body, headers = {}) => gateway.fetch(new Request('https://sandbox.test/sandbox/accept-only/requests', {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body,
}), env);
const eventRequest = (env, taskId, ticket, after = 0) => gateway.fetch(new Request(
  `https://sandbox.test/sandbox/accept-only/requests/${taskId}/events`,
  { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket, after }) },
), env);

afterEach(() => vi.useRealTimers());

describe('anonymous sandbox accept-only API', () => {
  it('fails closed when disabled or pointed at production configuration', async () => {
    const disabled = makeEnv({ TG_ACCEPT_ONLY_ENABLED: 'false' });
    expect((await post(disabled.env, JSON.stringify({ text: 'synthetic' }))).status).toBe(404);
    expect(disabled.namespace.get).not.toHaveBeenCalled();

    for (const overrides of [{ ENVIRONMENT: 'production' }, { ENV: 'prod' }, { BOT_TOKEN: 'configured' }, { BOT_USERNAME: 'super_personal_assistant_bot' }]) {
      const production = makeEnv(overrides);
      expect((await post(production.env, JSON.stringify({ text: 'synthetic' }))).status).toBe(404);
      expect(production.namespace.get).not.toHaveBeenCalled();
    }
  });

  it('keeps existing Telegram webhook authentication intact', async () => {
    const { env } = makeEnv();
    const response = await gateway.fetch(new Request('https://sandbox.test/webhook', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ update_id: 1 }),
    }), env);
    expect(response.status).toBe(401);
    const collector = await gateway.fetch(new Request('https://sandbox.test/collector-state?chatId=1001'), env);
    expect(collector.status).toBe(401);
  });

  it('enforces actual streamed body bytes and text bounds before storage', async () => {
    const { env, storage, internalRequests } = makeEnv();
    const tooLarge = await post(env, JSON.stringify({ text: 'x'.repeat(5000) }));
    expect(tooLarge.status).toBe(413);

    const oversizedStream = new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"text":"' + 'x'.repeat(5000) + '"}'));
      controller.close();
    } });
    const streamed = await gateway.fetch(new Request('https://sandbox.test/sandbox/accept-only/requests', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: oversizedStream, duplex: 'half',
    }), env);
    expect(streamed.status).toBe(413);
    expect((await post(env, JSON.stringify({ text: 'x'.repeat(2001) }))).status).toBe(400);
    expect((await post(env, JSON.stringify({ text: 'valid', profileId: 'attacker' }))).status).toBe(400);
    expect([...storage.values.keys()].filter(key => key.startsWith('run:'))).toHaveLength(0);
  });

  it('accepts without classification or execution and exposes only ticket-scoped replay', async () => {
    const { env, storage, internalRequests } = makeEnv();
    const cpFetch = env.CONTROL_PLANE_SERVICE.fetch;
    const runnerFetch = env.RUNNER.fetch;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const secretInput = 'private-synthetic-input-do-not-log';
    const firstResponse = await post(env, JSON.stringify({ text: secretInput }), { 'cf-connecting-ip': '192.0.2.10' });
    const secondResponse = await post(env, JSON.stringify({ text: 'second input' }), { 'cf-connecting-ip': '192.0.2.11' });
    expect(firstResponse.status).toBe(202);
    const first = await firstResponse.json();
    const second = await secondResponse.json();
    expect(first).toMatchObject({ mode: 'accept_only', executionStarted: false, tokenUsage: 0 });
    expect(first.taskId).not.toBe(second.taskId);
    expect(first.ticket).not.toBe(second.ticket);
    expect(first.eventsUrl).not.toContain(first.ticket);
    expect(first.eventsUrl).not.toContain('?');

    const own = await eventRequest(env, first.taskId, first.ticket);
    expect(own.status).toBe(200);
    expect(own.headers.get('cache-control')).toBe('no-store');
    const internalReplay = internalRequests.find(request => new URL(request.url).pathname === `/events/${first.taskId}`);
    expect(internalReplay.url).not.toContain(first.ticket);
    expect(internalReplay.headers.has('authorization')).toBe(false);
    expect(await internalReplay.json()).toMatchObject({ ticket: first.ticket, after: '0' });
    expect(await own.json()).toMatchObject({ events: [{ type: 'accepted_only', status: 'accepted_only', executionStarted: false, tokenUsage: 0 }], nextCursor: 1 });
    expect((await eventRequest(env, first.taskId, second.ticket)).status).toBe(404);
    expect((await eventRequest(env, second.taskId, first.ticket)).status).toBe(404);
    const oversizedReplay = await gateway.fetch(new Request(`https://sandbox.test/sandbox/accept-only/requests/${first.taskId}/events`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-ticket-test': first.ticket },
      body: JSON.stringify({ ticket: first.ticket, padding: 'x'.repeat(600) }),
    }), env);
    expect(oversizedReplay.status).toBe(413);
    expect((await eventRequest(env, first.taskId, first.ticket, 1).then(response => response.json())).events).toEqual([]);
    for (let index = 0; index < 58; index++) expect((await eventRequest(env, first.taskId, first.ticket, 1)).status).toBe(200);
    expect((await eventRequest(env, first.taskId, first.ticket, 1)).status).toBe(429);
    expect(cpFetch).not.toHaveBeenCalled();
    expect(runnerFetch).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join(' ')).not.toContain(secretInput);
    expect([...storage.values.values()].find(value => value?.text === secretInput)).toMatchObject({
      principalId: 'sandbox-accept-only', profileId: 'sandbox-accept-only-profile',
    });
    log.mockRestore();
  });

  it('expires tickets and records and rate-limits requests per source without storing the source IP', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-07T00:00:00Z'));
    const { env, storage, store } = makeEnv();
    let accepted;
    for (let index = 0; index < 5; index++) {
      const response = await post(env, JSON.stringify({ text: `request-${index}` }), { 'cf-connecting-ip': '198.51.100.5' });
      expect(response.status).toBe(202);
      if (index === 0) accepted = await response.json();
    }
    expect((await post(env, JSON.stringify({ text: 'rate limited' }), { 'cf-connecting-ip': '198.51.100.5' })).status).toBe(429);
    expect([...storage.values.keys()].some(key => key.includes('198.51.100.5'))).toBe(false);

    vi.advanceTimersByTime(15 * 60 * 1000 + 1);
    expect((await eventRequest(env, accepted.taskId, accepted.ticket)).status).toBe(404);
    await store.alarm();
    expect(await storage.get(`run:${accepted.taskId}`)).toBeUndefined();
    expect(storage.alarmAt).toBeNull();
  });

  it('enforces concurrent admission limits and ticket replay in a real local workerd Durable Object', async () => {
    const code = buildSync({ entryPoints: ['src/sandbox-tg/existing-ux.js'], bundle: true, write: false,
      external: ['node:buffer'], format: 'esm', platform: 'browser' }).outputFiles[0].text;
    const fetchMock = createFetchMock();
    fetchMock.disableNetConnect();
    const runtime = new Miniflare({ modules: true, script: code, compatibilityDate: '2024-01-01', compatibilityFlags: ['nodejs_compat'], fetchMock,
      bindings: { TG_ACCEPT_ONLY_ENABLED: 'true', TG_ACCEPT_ONLY_ENVIRONMENT: 'sandbox', TG_ACCEPT_ONLY_MODE: 'accept-only',
        TG_SANDBOX_BOT_USERNAME: 'probability_cat_bot' },
      durableObjects: { SANDBOX_ACCEPT_ONLY: { className: 'SandboxAcceptOnlyStore', useSQLite: true } },
    });
    try {
      const replies = await Promise.all(Array.from({ length: 6 }, (_, index) => runtime.dispatchFetch(
        'https://sandbox.test/sandbox/accept-only/requests', {
          method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.40' },
          body: JSON.stringify({ text: `bounded-${index}` }),
        })));
      expect(replies.map(response => response.status).sort()).toEqual([202, 202, 202, 202, 202, 429]);
      const accepted = await replies.find(response => response.status === 202).json();
      const replay = await runtime.dispatchFetch(accepted.eventsUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticket: accepted.ticket, after: 0 }),
      });
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ events: [{ type: 'accepted_only', taskId: accepted.taskId }], nextCursor: 1 });
    } finally {
      await runtime.dispose();
      await fetchMock.close();
    }
  }, 20000);
});
