import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/sandbox-tg/index.js';
import { FakeControlPlane } from '../src/sandbox-tg/fake-control-plane.js';
import { TgDeliveryOutbox } from '../src/sandbox-tg/delivery.js';
import { MemKV, makeEnv } from './helpers/p11-helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('v1 Telegram routing and delivery evidence', () => {
  function request(env, path, body) {
    return worker.fetch(new Request(`https://gateway.test${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': env.TELEGRAM_WEBHOOK_SECRET },
      body: body ? JSON.stringify(body) : undefined,
    }), env);
  }

  it.each(['deterministic', 'agent'])('routes an accepted update through the control plane instead of starting directly (%s)', async route => {
    const env = makeEnv({ TG_SLICE: new MemKV(), TG_SLICE_ROUTER_ENABLED: 'true' });
    const fake = new FakeControlPlane();
    const calls = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('fetch', async (input, init) => {
      const path = new URL(input).pathname;
      calls.push({ path, body: init.body ? JSON.parse(init.body) : null });
      if (path === '/route') return Response.json({ route, continuation: { issued: route === 'agent' } });
      const response = await fake.fetch(input, init);
      return Response.json(response.value, { status: response.status });
    });
    const update = { update_id: 500, message: { message_id: 42, chat: { id: 1001, type: 'private' }, from: { id: 1001 }, text: 'Работает?' } };
    const receipt = await (await request(env, '/webhook', update)).json();
    const duplicate = await (await request(env, '/webhook', update)).json();
    expect(receipt.userTaskId).toBeTruthy();
    expect(duplicate).toMatchObject({ duplicate: true, userTaskId: receipt.userTaskId });
    expect(calls.filter(call => call.path === '/route')).toEqual([{ path: '/route', body: { taskId: receipt.userTaskId, continue: true } }]);
    expect(calls.some(call => call.path === '/start')).toBe(false);
    expect(fake.tasks).toHaveLength(1);
  });

  it('exposes actual provider acceptance separately from a queued receipt without leaking content', async () => {
    const env = makeEnv({ TG_SLICE: new MemKV() });
    const outbox = new TgDeliveryOutbox(env.TG_SLICE, null);
    await outbox.enqueue({ userTaskId: 'task-1', deliveryId: 'terminal:task-1', destination: { chatId: 1001, threadId: 7 }, type: 'message', text: 'private answer' });
    const record = await outbox.load('terminal:task-1');
    record.status = 'sent';
    record.telegramMessageId = 901;
    await outbox.save(record);
    const response = await request(env, '/deliveries/task-1');
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.receipt).toBeNull();
    expect(data.terminal).toMatchObject({ status: 'sent', providerMessageId: 901, chatId: 1001, threadId: 7 });
    expect(JSON.stringify(data)).not.toContain('private answer');
    const unsigned = await worker.fetch(new Request('https://gateway.test/deliveries/task-1'), env);
    expect(unsigned.status).toBe(401);
  });

  it('refuses delivery records addressed outside the configured test chats', async () => {
    const env = makeEnv({ TG_SLICE: new MemKV() });
    await new TgDeliveryOutbox(env.TG_SLICE, null).enqueue({ userTaskId: 'task-2', destination: { chatId: 9999 }, type: 'message', text: 'other chat' });
    expect((await request(env, '/deliveries/task-2')).status).toBe(403);
  });
});
