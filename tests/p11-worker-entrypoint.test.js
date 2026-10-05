import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/sandbox-tg/index.js';
import { readTgSliceConfig } from '../src/sandbox-tg/config.js';
import { TelegramApi } from '../src/sandbox-tg/telegram.js';
import { TelegramEmulator } from '../src/sandbox-tg/telegram-emulator.js';
import { FakeControlPlane } from '../src/sandbox-tg/fake-control-plane.js';
import { TgDeliveryOutbox } from '../src/sandbox-tg/delivery.js';
import { MemKV, makeEnv } from './helpers/p11-helpers.js';

describe('P11 exported Worker composition', () => {
  let env, fake, emulator, fetchSpy;

  beforeEach(() => {
    env = makeEnv({ TG_SLICE: new MemKV({ pageSize: 1 }) });
    fake = new FakeControlPlane();
    emulator = new TelegramEmulator();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    fetchSpy = vi.fn(async (input, init) => {
      const url = new URL(input);
      if (url.origin === env.CONTROL_PLANE_URL) {
        const result = await fake.fetch(input, init);
        return Response.json(result.value, { status: result.status });
      }
      if (url.origin === env.TELEGRAM_API_BASE) {
        if (!url.pathname.startsWith(`/bot${env.TG_SANDBOX_BOT_TOKEN}/`)) {
          return Response.json({ ok: false, error_code: 401 }, { status: 401 });
        }
        return emulator.fetch(input, init);
      }
      throw new Error('unexpected fixture origin');
    });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function webhook(update, secret = env.TELEGRAM_WEBHOOK_SECRET) {
    const headers = { 'content-type': 'application/json' };
    if (secret != null) headers['x-telegram-bot-api-secret-token'] = secret;
    return worker.fetch(new Request('https://sandbox.test/webhook', {
      method: 'POST', headers, body: JSON.stringify(update),
    }), env);
  }

  it.each([null, '', 'wrong-secret'])('rejects unsigned or invalid webhook (%s) before side effects', async secret => {
    const response = await webhook(emulator.pushMessage({ chatId: 1001, text: 'hello' }), secret);
    expect(response.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(env.TG_SLICE.data.size).toBe(0);
  });

  it.each([undefined, '', '   '])('fails closed without a configured webhook secret (%s), while health stays public', async secret => {
    env.TELEGRAM_WEBHOOK_SECRET = secret;
    const response = await webhook(emulator.pushMessage({ chatId: 1001, text: 'hello' }), 'claimed-secret');
    expect(response.status).toBe(401);
    const health = await worker.fetch(new Request('https://sandbox.test/health'), env);
    expect(health.status).toBe(200);
    expect((await health.json()).status).toBe('ok');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects unlisted chats and malformed signed updates', async () => {
    expect((await webhook(emulator.pushMessage({ chatId: 9999, text: 'hello' }))).status).toBe(403);
    expect((await webhook({ message: {} })).status).toBe(400);
    const response = await worker.fetch(new Request('https://sandbox.test/webhook', {
      method: 'POST', headers: { 'x-telegram-bot-api-secret-token': env.TELEGRAM_WEBHOOK_SECRET }, body: '{',
    }), env);
    expect(response.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('deduplicates actual HTTP updates across fresh controllers and sends the receipt with the configured token', async () => {
    const update = emulator.pushMessage({ chatId: 1001, text: 'hello' });
    const response = await webhook(update);
    expect(response.status).toBe(200);
    const receipt = await response.json();
    expect(receipt.userTaskId).toBeTruthy();
    const duplicate = await webhook(update);
    expect((await duplicate.json()).duplicate).toBe(true);
    expect(fake.tasks).toHaveLength(1);
    expect(fake.httpLog.filter(call => call.path === '/signal')).toHaveLength(0);
    expect(await env.TG_SLICE.get('conv:undefined')).toBeNull();
    await worker.scheduled({}, env);
    expect(emulator.messagesTo(1001)).toHaveLength(1);
    expect(env._sliceCtrl).toBeUndefined();
    const logs = console.log.mock.calls.flat().join('\n');
    expect(logs).not.toContain(env.TG_SANDBOX_BOT_TOKEN);
    expect(logs).not.toContain(env.TELEGRAM_WEBHOOK_SECRET);
  });

  it('scheduled cold start drains all KV pages and preserves bounded retries', async () => {
    const outbox = new TgDeliveryOutbox(env.TG_SLICE, null);
    for (const taskId of ['task-1', 'task-2']) {
      await outbox.enqueue({ userTaskId: taskId, requestId: taskId, destination: { chatId: 1001 }, type: 'message', text: taskId });
    }
    env.TG_SLICE_DELIVERY_MAX_ATTEMPTS = '2';
    emulator.failNext({ status: 500 });
    await worker.scheduled({}, env);
    expect((await outbox.load('task-1')).status).toBe('retrying');
    expect((await outbox.load('task-2')).status).toBe('sent');
    emulator.failNext({ status: 500 });
    await worker.scheduled({}, env);
    expect((await outbox.load('task-1')).status).toBe('dead');
    await worker.scheduled({}, env);
    expect((await outbox.load('task-1')).attempts).toBe(2);
    expect(emulator.messagesTo(1001)).toHaveLength(1);
  });

  it('delivers the final answer after a sent receipt to the original chat and thread, once', async () => {
    await webhook(emulator.pushMessage({ chatId: 1001, messageThreadId: 7, text: 'question' }));
    await worker.scheduled({}, env);
    const answer = 'The verified answer';
    await webhook(emulator.pushMessage({ chatId: 1001, messageThreadId: 7, text: answer }));
    await env.TG_SLICE.put('conv:broken', '{');
    await worker.scheduled({}, env);
    await worker.scheduled({}, env);
    const messages = emulator.messagesTo(1001);
    expect(messages.filter(item => item.message.text === answer)).toHaveLength(1);
    expect(messages.find(item => item.message.text === answer).request.message_thread_id).toBe(7);
    expect(emulator.messagesTo('profile-1')).toHaveLength(0);
    expect(fake.tasks).toHaveLength(1);
    expect(fake.runs(fake.tasks[0].user_task_id)).toHaveLength(1);
  });

  it('continues KV pagination through an empty incomplete page', async () => {
    const outbox = new TgDeliveryOutbox(env.TG_SLICE, null);
    await outbox.enqueue({ userTaskId: 'late-task', destination: { chatId: 1001 }, type: 'message', text: 'later page' });
    const list = env.TG_SLICE.list.bind(env.TG_SLICE);
    vi.spyOn(env.TG_SLICE, 'list').mockImplementation(options => {
      if (options.prefix === 'delivery:' && !options.cursor) {
        return Promise.resolve({ keys: [], list_complete: false, cursor: 'empty-page' });
      }
      return list({ ...options, cursor: options.cursor === 'empty-page' ? '' : options.cursor });
    });
    await worker.scheduled({}, env);
    expect(emulator.messagesTo(1001).map(item => item.message.text)).toEqual(['later page']);
  });

  it('deleteMessage sends the supplied chat and message IDs through the Bot API', async () => {
    const api = new TelegramApi(readTgSliceConfig(env));
    const message = await api.sendMessage({ chatId: 1001, text: 'delete me' });
    expect(await api.deleteMessage({ chatId: 1001, messageId: message.message_id })).toBe(true);
    expect(emulator.messagesTo(1001)).toHaveLength(0);
    const [url, init] = fetchSpy.mock.calls.at(-1);
    expect(new URL(url).pathname.endsWith('/deleteMessage')).toBe(true);
    expect(JSON.parse(init.body)).toEqual({ chat_id: 1001, message_id: message.message_id });
  });

  it('keeps health available with missing delivery bindings, but refuses a signed webhook without a bot token', async () => {
    delete env.TG_SANDBOX_BOT_TOKEN;
    delete env.TG_SLICE;
    expect((await worker.fetch(new Request('https://sandbox.test/health'), env)).status).toBe(200);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await webhook(emulator.pushMessage({ chatId: 1001, text: 'hello' }))).status).toBe(503);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('protects the HTTP reconciliation route and uses the same composition when authorized', async () => {
    const outbox = new TgDeliveryOutbox(env.TG_SLICE, null);
    await outbox.enqueue({ userTaskId: 'cron-task', destination: { chatId: 1001 }, type: 'message', text: 'cron reply' });
    expect((await worker.fetch(new Request('https://sandbox.test/cron'), env)).status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
    const response = await worker.fetch(new Request('https://sandbox.test/cron', {
      headers: { 'x-telegram-bot-api-secret-token': env.TELEGRAM_WEBHOOK_SECRET },
    }), env);
    expect(response.status).toBe(200);
    expect((await response.json()).drained).toBe(1);
    expect(emulator.messagesTo(1001).map(item => item.message.text)).toEqual(['cron reply']);
  });

  it('preserves terminal delivery history and reaches the retry cap without rerunning the task', async () => {
    env.TG_SLICE_DELIVERY_MAX_ATTEMPTS = '2';
    await webhook(emulator.pushMessage({ chatId: 1001, text: 'question' }));
    await worker.scheduled({}, env);
    await webhook(emulator.pushMessage({ chatId: 1001, text: 'actual answer' }));
    const taskId = fake.tasks[0].user_task_id;
    const outbox = new TgDeliveryOutbox(env.TG_SLICE, null);
    const deliveryOutbox = new TgDeliveryOutbox(env.TG_SLICE, new TelegramApi(readTgSliceConfig(env)));
    await deliveryOutbox.drain();
    const deliveryId = `terminal:${taskId}:g1`;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      emulator.failNext({ status: 500 });
      await worker.scheduled({}, env);
      const record = await outbox.load(deliveryId);
      expect(record.attempts).toBe(attempt);
      expect(record.history).toHaveLength(attempt);
    }
    await worker.scheduled({}, env);
    expect((await outbox.load(deliveryId)).status).toBe('dead');
    expect((await outbox.load(deliveryId)).attempts).toBe(2);
    expect(fake.runs(taskId)).toHaveLength(1);
    expect(emulator.messagesTo(1001).some(item => item.message.text === 'actual answer')).toBe(false);
  });

  it('does not guess a destination from a profile ID for legacy or disallowed conversation indexes', async () => {
    await webhook(emulator.pushMessage({ chatId: 1001, text: 'question' }));
    await worker.scheduled({}, env);
    await webhook(emulator.pushMessage({ chatId: 1001, text: 'answer' }));
    const index = JSON.parse(await env.TG_SLICE.get('conv:tg-1001'));
    delete index.destination;
    await env.TG_SLICE.put('conv:tg-1001', JSON.stringify(index));
    await worker.scheduled({}, env);
    index.destination = { chatId: 9999, threadId: null };
    await env.TG_SLICE.put('conv:tg-1001', JSON.stringify(index));
    await worker.scheduled({}, env);
    expect(emulator.messagesTo(9999)).toHaveLength(0);
    expect(emulator.messagesTo('profile-1')).toHaveLength(0);
    expect(emulator.messagesTo(1001).some(item => item.message.text === 'answer')).toBe(false);
  });

  it('reports unknown execution honestly and can still deliver a later final answer', async () => {
    await webhook(emulator.pushMessage({ chatId: 1001, text: 'question' }));
    await worker.scheduled({}, env);
    const taskId = fake.tasks[0].user_task_id;
    await fake.connectionLost({ runId: fake.runs(taskId)[0].id });
    await worker.scheduled({}, env);
    await worker.scheduled({}, env);
    expect(emulator.messagesTo(1001).filter(item => item.message.text.includes('Исход задачи неизвестен'))).toHaveLength(1);
    await webhook(emulator.pushMessage({ chatId: 1001, text: 'recovered result' }));
    await worker.scheduled({}, env);
    expect(emulator.messagesTo(1001).filter(item => item.message.text === 'recovered result')).toHaveLength(1);
  });

  it('requires a sandbox token and reads an optional trimmed principal signature', () => {
    expect(() => readTgSliceConfig(makeEnv({ TG_SANDBOX_BOT_TOKEN: '' }))).toThrow('TG_SANDBOX_BOT_TOKEN');
    expect(readTgSliceConfig(makeEnv({ CONTROL_PLANE_PRINCIPAL_SIGNATURE: ' signature ' })).principalSignature).toBe('signature');
    expect(readTgSliceConfig(makeEnv({ CONTROL_PLANE_PRINCIPAL_SIGNATURE: '   ' })).principalSignature).toBeNull();
  });

  it('retains the final reply across a transient delivery failure and sends it once on the next schedule', async () => {
    await webhook(emulator.pushMessage({ chatId: 1001, text: 'question' }));
    await worker.scheduled({}, env);
    await webhook(emulator.pushMessage({ chatId: 1001, text: 'retry this result' }));
    const outbox = new TgDeliveryOutbox(env.TG_SLICE, new TelegramApi(readTgSliceConfig(env)));
    await outbox.drain();
    emulator.failNext({ status: 500 });
    await worker.scheduled({}, env);
    await worker.scheduled({}, env);
    await worker.scheduled({}, env);
    expect(emulator.messagesTo(1001).filter(item => item.message.text === 'retry this result')).toHaveLength(1);
    const record = await outbox.load(`terminal:${fake.tasks[0].user_task_id}:g1`);
    expect(record.status).toBe('sent');
    expect(record.attempts).toBe(2);
    expect(record.history).toHaveLength(1);
  });

  it('tracks launched batches for final delivery through the exported callback and scheduled handlers', async () => {
    env.TG_SLICE_MODE = 'batch';
    await webhook(emulator.pushMessage({ chatId: 1001, text: 'first item' }));
    await webhook(emulator.pushMessage({ chatId: 1001, text: 'second item' }));
    await webhook(emulator.pushUpdate({ callback_query: {
      id: 'foreign-launch', data: 'tg-launch:tg-1001', message: { message_id: 10, chat: { id: 1002 } },
    } }));
    expect(fake.tasks).toHaveLength(0);
    const callback = emulator.pushUpdate({ callback_query: {
      id: 'launch-1', data: 'tg-launch:tg-1001', message: { message_id: 10, chat: { id: 1001 } },
    } });
    const response = await webhook(callback);
    expect(response.status).toBe(200);
    const receipt = await response.json();
    expect((await (await webhook(callback)).json()).duplicate).toBe(true);
    await worker.scheduled({}, env);
    await fake.signal(receipt.userTaskId, {
      idempotencyKey: 'batch-fixture-answer', payload: { answer: 'batch result' },
    });
    await worker.scheduled({}, env);
    await worker.scheduled({}, env);
    expect(emulator.messagesTo(1001).filter(item => item.message.text === 'batch result')).toHaveLength(1);
    expect(fake.tasks).toHaveLength(1);
    const accepted = fake.eventLog.find(event => event.kind === 'task_accepted');
    expect(accepted.payload.inputItems).toHaveLength(2);
  });
});
