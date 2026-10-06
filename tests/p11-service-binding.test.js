import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/sandbox-tg/index.js';
import { FakeControlPlane } from '../src/sandbox-tg/fake-control-plane.js';
import { TelegramEmulator } from '../src/sandbox-tg/telegram-emulator.js';
import { MemKV, makeEnv } from './helpers/p11-helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function webhook(env, update) {
  return worker.fetch(new Request('https://gateway.test/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': env.TELEGRAM_WEBHOOK_SECRET },
    body: JSON.stringify(update),
  }), env);
}

describe('P11 Worker control-plane service binding', () => {
  it.each([true, false])('uses the selected transport for HTTP and scheduled handlers, preserving authentication (binding=%s)', async bound => {
    const env = makeEnv({ TG_SLICE: new MemKV(), CONTROL_PLANE_API_KEY: 'fixture-api-key', TG_SLICE_ROUTER_ENABLED: 'true' });
    env.CONTROL_PLANE_PRINCIPAL_SIGNATURE = createHmac('sha256', 'fixture-signing-key')
      .update(env.CONTROL_PLANE_PRINCIPAL).digest('hex');
    const fake = new FakeControlPlane();
    const telegram = new TelegramEmulator();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let service;
    const controlFetch = vi.fn(async function(input, init) {
      if (bound) expect(this).toBe(service);
      expect(new URL(input).origin).toBe(env.CONTROL_PLANE_URL);
      expect(init.headers.get('x-principal')).toBe(env.CONTROL_PLANE_PRINCIPAL);
      expect(init.headers.get('x-principal-sig')).toBe(env.CONTROL_PLANE_PRINCIPAL_SIGNATURE);
      expect(init.headers.get('authorization')).toBe(`Bearer ${env.CONTROL_PLANE_API_KEY}`);
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.signal.aborted).toBe(false);
      if (new URL(input).pathname === '/route') {
        const body = JSON.parse(init.body);
        await fake.start(body.taskId, { goal: 'fixture routed task' });
        return Response.json({ route: 'agent', continuation: { issued: true } });
      }
      const response = await fake.fetch(input, init);
      return Response.json(response.value, { status: response.status });
    });
    service = { fetch: controlFetch };
    if (bound) env.CONTROL_PLANE_SERVICE = service;
    const externalFetch = vi.fn((input, init) => {
      if (new URL(input).origin === env.TELEGRAM_API_BASE) return telegram.fetch(input, init);
      if (bound) throw new Error('control-plane external transport must not be used');
      return controlFetch(input, init);
    });
    vi.stubGlobal('fetch', externalFetch);
    const response = await webhook(env, telegram.pushMessage({ chatId: 1001, text: 'question' }));
    expect(response.status).toBe(200);
    const receipt = await response.json();
    const intake = controlFetch.mock.calls.find(([input]) => new URL(input).pathname === '/intake');
    expect(intake[1].method).toBe('POST');
    expect(JSON.parse(intake[1].body)).toMatchObject({ profileId: env.CONTROL_PLANE_PROFILE, inputItems: [{ text: 'question', artifactRefs: [] }] });
    expect(controlFetch.mock.calls.some(([input]) => new URL(input).pathname === '/route')).toBe(true);
    expect(controlFetch.mock.calls.some(([input]) => new URL(input).pathname === '/start')).toBe(false);
    await worker.scheduled({}, env);
    expect(telegram.messagesTo(1001)).toHaveLength(1);
    expect((await webhook(env, telegram.pushMessage({ chatId: 1001, text: 'bound final answer' }))).status).toBe(200);
    const callsBeforeSchedule = controlFetch.mock.calls.length;
    await worker.scheduled({}, env);
    expect(controlFetch.mock.calls.length).toBeGreaterThan(callsBeforeSchedule);
    await worker.scheduled({}, env);
    expect(telegram.messagesTo(1001).filter(item => item.message.text === 'bound final answer')).toHaveLength(1);
    expect(fake.tasks).toHaveLength(1);
    expect(receipt.userTaskId).toBe(fake.tasks[0].user_task_id);
    if (bound) {
      expect(externalFetch.mock.calls.every(([input]) => new URL(input).origin === env.TELEGRAM_API_BASE)).toBe(true);
    } else {
      expect(externalFetch.mock.calls.some(([input]) => new URL(input).origin === env.CONTROL_PLANE_URL)).toBe(true);
    }
  });

  it('preserves the client timeout signal on a stalled bound request without external fallback', async () => {
    const env = makeEnv({ TG_SLICE: new MemKV(), TG_SLICE_REQUEST_TIMEOUT_MS: '100' });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const boundFetch = vi.fn((input, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    }));
    env.CONTROL_PLANE_SERVICE = { fetch: boundFetch };
    const externalFetch = vi.fn(() => { throw new Error('unexpected external fallback'); });
    vi.stubGlobal('fetch', externalFetch);
    const response = await webhook(env, { update_id: 1, message: { message_id: 1, chat: { id: 1001 }, text: 'hello' } });
    expect(response.status).toBe(500);
    expect(boundFetch).toHaveBeenCalledTimes(1);
    expect(boundFetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(externalFetch).not.toHaveBeenCalled();
  });

  it('does not bypass a bound control-plane authentication failure using external fetch', async () => {
    const env = makeEnv({ TG_SLICE: new MemKV() });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const boundFetch = vi.fn(async () => Response.json({ error: 'unauthorized' }, { status: 401 }));
    env.CONTROL_PLANE_SERVICE = { fetch: boundFetch };
    const externalFetch = vi.fn();
    vi.stubGlobal('fetch', externalFetch);
    const response = await webhook(env, { update_id: 1, message: { message_id: 1, chat: { id: 1001 }, text: 'hello' } });
    expect(response.status).toBe(500);
    expect(boundFetch).toHaveBeenCalledTimes(1);
    expect(externalFetch).not.toHaveBeenCalled();
  });
});
