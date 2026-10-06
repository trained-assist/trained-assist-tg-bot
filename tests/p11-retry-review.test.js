import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/sandbox-tg/index.js';
import { FakeControlPlane } from '../src/sandbox-tg/fake-control-plane.js';
import { TelegramEmulator } from '../src/sandbox-tg/telegram-emulator.js';
import { MemKV, makeEnv } from './helpers/p11-helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture(failure = null) {
  const env = makeEnv({ TG_SLICE: new MemKV({ pageSize: 1 }), TG_SLICE_ROUTER_ENABLED: 'true' });
  const fake = new FakeControlPlane();
  const emulator = new TelegramEmulator();
  const calls = [];
  let armed = failure != null;
  const trip = point => {
    if (armed && failure === point) {
      armed = false;
      throw new Error(`injected ${point}`);
    }
  };
  const put = env.TG_SLICE.put.bind(env.TG_SLICE);
  vi.spyOn(env.TG_SLICE, 'put').mockImplementation(async (key, value) => {
    if (key === 'conv:u:700') trip('dedup-write');
    if (key === 'conv:tg-1001-t7' && JSON.parse(value).turns?.length) trip('turn-write');
    return put(key, value);
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', async (input, init) => {
    const url = new URL(input);
    if (url.origin === env.TELEGRAM_API_BASE) return emulator.fetch(input, init);
    expect(url.origin).toBe(env.CONTROL_PLANE_URL);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path: url.pathname, body });
    if (url.pathname === '/intake') trip('before-intake');
    if (url.pathname === '/route') {
      const task = fake.tasks.find(entry => entry.user_task_id === body.taskId);
      task.status = 'done';
      task.generation = 1;
      task.result = { answer: 'Verified healthy' };
      trip('route-ack');
      return Response.json({ route: 'deterministic', execution: { agentStarted: false } });
    }
    const response = await fake.fetch(input, init);
    if (url.pathname === '/intake') trip('intake-ack');
    return Response.json(response.value, { status: response.status });
  });
  const request = (path, body, secret = env.TELEGRAM_WEBHOOK_SECRET) => worker.fetch(new Request(`https://gateway.test${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
    body: body ? JSON.stringify(body) : undefined,
  }), env);
  const update = { update_id: 700, message: { message_id: 42, message_thread_id: 7, chat: { id: 1001 }, text: 'health' } };
  return { env, fake, emulator, calls, request, update };
}

describe('independent v1 retry review', () => {
  it.each(['before-intake', 'intake-ack', 'route-ack', 'turn-write', 'dedup-write'])('recovers the same update after %s without another task or final reply', async failure => {
    const { env, fake, emulator, calls, request, update } = fixture(failure);
    expect((await request('/webhook', update)).status).toBe(500);
    const retry = await request('/webhook', update);
    expect(retry.status).toBe(200);
    const receipt = await retry.json();
    expect(receipt.userTaskId).toBe(fake.tasks[0].user_task_id);
    expect(fake.tasks).toHaveLength(1);
    expect(new Set(calls.filter(call => call.path === '/intake').map(call => call.body.requestId))).toEqual(new Set([
      'tg:probability_cat_bot:1001:7:42:u700',
    ]));
    const index = JSON.parse(await env.TG_SLICE.get('conv:tg-1001-t7'));
    expect(index.turns).toHaveLength(1);
    expect(calls.some(call => call.path === '/start')).toBe(false);
    expect((await (await request('/webhook', update)).json()).userTaskId).toBe(receipt.userTaskId);
    await worker.scheduled({}, env);
    await worker.scheduled({}, env);
    const answers = emulator.messagesTo(1001).filter(entry => entry.message.text === 'Verified healthy');
    expect(answers).toHaveLength(1);
    expect(answers[0].request.message_thread_id).toBe(7);
  });

  it('reports the actual generation-scoped final delivery created by the webhook', async () => {
    const { env, fake, request, update } = fixture();
    const receipt = await (await request('/webhook', update)).json();
    await worker.scheduled({}, env);
    expect((await request(`/deliveries/${receipt.userTaskId}`, null, 'wrong-secret')).status).toBe(401);
    const response = await request(`/deliveries/${receipt.userTaskId}`);
    expect(response.status).toBe(200);
    await worker.scheduled({}, env);
    const evidence = await (await request(`/deliveries/${receipt.userTaskId}`)).json();
    expect(evidence.terminal).toMatchObject({ deliveryId: `terminal:${receipt.userTaskId}:g1`, generation: fake.tasks[0].generation, status: 'sent', chatId: 1001, threadId: 7 });
    expect(evidence.terminal.providerMessageId).toBeTruthy();
    expect(JSON.stringify(evidence)).not.toContain('Verified healthy');
    env.TG_SLICE_ALLOWED_CHATS = '1002';
    expect((await request(`/deliveries/${receipt.userTaskId}`)).status).toBe(403);
  });

  it('reports the receipt written under its ingress request ID', async () => {
    const { env, request, update } = fixture();
    const receipt = await (await request('/webhook', update)).json();
    await worker.scheduled({}, env);
    await worker.scheduled({}, env);
    const evidence = await (await request(`/deliveries/${receipt.userTaskId}`)).json();
    expect(evidence.receipt).toMatchObject({ userTaskId: receipt.userTaskId, status: 'sent' });
  });

  it('selects generation 10 over generation 2 using records emitted by reconciliation', async () => {
    const { env, fake, request, update } = fixture();
    const receipt = await (await request('/webhook', update)).json();
    const task = fake.tasks[0];
    task.generation = 2;
    await worker.scheduled({}, env);
    task.generation = 10;
    await worker.scheduled({}, env);
    await worker.scheduled({}, env);
    const evidence = await (await request(`/deliveries/${receipt.userTaskId}`)).json();
    expect(evidence.terminal).toMatchObject({ deliveryId: `terminal:${receipt.userTaskId}:g10`, generation: task.generation, status: 'sent' });
  });

  it('accepts a v1 message beyond the obsolete 32-turn fixture cap', async () => {
    const { env, fake, request, update } = fixture();
    await env.TG_SLICE.put('conv:tg-1001-t7', JSON.stringify({
      conversationId: 'tg-1001-t7', profileId: env.CONTROL_PLANE_PROFILE, cursors: {},
      turns: Array.from({ length: 32 }, (_, position) => ({ seq: position + 1, userTaskId: 'old-task', requestId: `old-${position}`, conversationId: 'tg-1001-t7' })),
    }));
    fake.tasks.push({ user_task_id: 'old-task', status: 'done', generation: 1, result: { answer: 'old answer' } });
    expect((await request('/webhook', update)).status).toBe(200);
    expect(JSON.parse(await env.TG_SLICE.get('conv:tg-1001-t7')).turns).toHaveLength(33);
  });
});
