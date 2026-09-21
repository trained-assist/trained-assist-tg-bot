import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { trackUI, processExpiredUI, rejectExpiredUI, projectChoiceExpired, PICKER_TTL_MS, MENU_TTL_MS, KV_PROPAGATION_GRACE_MS } from '../src/lib/transient-ui.js';
import { sendMessageWithKeyboard, editMessage } from '../src/lib/telegram.js';

let records, env, requests;
const now = 1800000000000;
const keyboard = data => [[{ text: 'Choose', callback_data: data }]];
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  records = new Map(); requests = [];
  env = { BOT_TOKEN: '123:secret', SESSIONS: {
    put: vi.fn(async (k, v) => records.set(k, JSON.parse(v))),
    get: vi.fn(async (k, options) => options?.type === 'json' ? records.get(k) : (records.has(k) ? JSON.stringify(records.get(k)) : null)),
    delete: vi.fn(async k => records.delete(k)),
    list: vi.fn(async ({ prefix }) => ({ keys: [...records.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true })),
  } };
  vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
    requests.push({ method: url.split('/').pop(), body: JSON.parse(opts.body) });
    return { json: async () => ({ ok: true, result: { message_id: 7, date: now / 1000 } }) };
  }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('durable temporary Telegram interfaces', () => {
  it.each([42, -10042])('chat %s: send → survives worker state loss → expires at actual picker TTL', async chatId => {
    await sendMessageWithKeyboard(env.BOT_TOKEN, chatId, 'project?', keyboard('pp:0'), {}, env);
    expect(records.size).toBe(1);
    await processExpiredUI({ ...env }, now + PICKER_TTL_MS - 1);
    expect(requests.map(x => x.method)).toEqual(['sendMessage']);
    await processExpiredUI({ ...env }, now + PICKER_TTL_MS);
    expect(requests.at(-1)).toEqual({ method: 'deleteMessage', body: { chat_id: chatId, message_id: 7 } });
    expect(records.size).toBe(0);
  });
  it('navigation expires after 15 minutes, only the owning bot drains shared KV', async () => {
    await trackUI(env, 42, 7, keyboard('sd:s-1'));
    await trackUI({ ...env, BOT_TOKEN: '456:other' }, 42, 8, keyboard('sd:s-2'));
    await processExpiredUI(env, now + MENU_TTL_MS - 1);
    expect(requests).toHaveLength(0);
    await processExpiredUI(env, now + MENU_TTL_MS);
    expect(records.size).toBe(1);
    expect(requests[0].body.message_id).toBe(7);
  });
  it.each(['plan|s-1', 'qa_more|s-1', 'intake_run', 'prof:logout'])('preserves durable/non-menu controls: %s', async data => {
    await trackUI(env, 42, 7, keyboard(data));
    expect(records.size).toBe(0);
  });
  it('a failed send creates no cleanup record', async () => {
    fetch.mockResolvedValueOnce({ json: async () => ({ ok: false }) });
    await sendMessageWithKeyboard(env.BOT_TOKEN, 42, '?', keyboard('pp:0'), {}, env);
    expect(records.size).toBe(0);
  });
  it('removing picker buttons cancels cleanup and preserves the resulting message', async () => {
    await trackUI(env, 42, 7, keyboard('pp:0'));
    await editMessage(env.BOT_TOKEN, 42, 7, 'Started', { lifecycleEnv: env, reply_markup: { inline_keyboard: [] } });
    expect(requests[0].body.lifecycleEnv).toBeUndefined();
    await processExpiredUI(env, now + MENU_TTL_MS);
    expect(requests.map(x => x.method)).toEqual(['editMessageText']);
  });
  it('failed edits keep cleanup scheduled', async () => {
    await trackUI(env, 42, 7, keyboard('pp:0'));
    fetch.mockResolvedValueOnce({ json: async () => ({ ok: false }) });
    await editMessage(env.BOT_TOKEN, 42, 7, 'Started', { lifecycleEnv: env, reply_markup: { inline_keyboard: [] } });
    expect(records.size).toBe(1);
  });
  it('falls back to stripping markup when deletion is forbidden', async () => {
    await trackUI(env, 42, 7, keyboard('pp:0'));
    fetch.mockResolvedValueOnce({ json: async () => ({ ok: false, description: "message can't be deleted" }) });
    await processExpiredUI(env, now + PICKER_TTL_MS);
    expect(requests.at(-1).method).toBe('editMessageReplyMarkup');
    expect(records.size).toBe(0);
  });
  it('retries API and network failures without losing the queue', async () => {
    await trackUI(env, 42, 7, keyboard('pp:0'));
    fetch.mockRejectedValueOnce(new Error('offline'));
    await processExpiredUI(env, now + PICKER_TTL_MS);
    expect(records.size).toBe(1);
    fetch.mockResolvedValueOnce({ json: async () => ({ ok: false, error_code: 429 }) });
    fetch.mockResolvedValueOnce({ json: async () => ({ ok: false, error_code: 429 }) });
    await processExpiredUI(env, now + PICKER_TTL_MS);
    expect(records.size).toBe(1);
    await processExpiredUI(env, now + PICKER_TTL_MS + 60000);
    expect(records.size).toBe(0);
  });
  it('drains every KV page', async () => {
    await trackUI(env, 42, 7, keyboard('pp:0'));
    await trackUI(env, 42, 8, keyboard('pp:0'));
    const keys = [...records.keys()];
    env.SESSIONS.list.mockResolvedValueOnce({ keys: [{ name: keys[0] }], list_complete: false, cursor: 'next' })
      .mockResolvedValueOnce({ keys: [{ name: keys[1] }], list_complete: true });
    await processExpiredUI(env, now + PICKER_TTL_MS);
    expect(env.SESSIONS.list.mock.calls[1][0].cursor).toBe('next');
    expect(records.size).toBe(0);
  });
  it.each(['pp:0', 'sp:s-1', 'ar:all'])('rejects stale legacy %s before performing actions', async data => {
    const cq = { id: 'cq', data, message: { message_id: 7, date: (now - MENU_TTL_MS) / 1000, chat: { id: 42 } } };
    expect(await rejectExpiredUI(cq, env, { pendingMessage: 'new task', pendingMessageAt: now })).toBe(true);
    expect(requests[0].method).toBe('answerCallbackQuery');
    expect(requests[1].method).toBe('deleteMessage');
  });
  it('rejects a superseded picker without clearing the newer pending task', async () => {
    const session = { pendingMessage: 'new task', pendingMessageAt: now, pendingPickerId: 8 };
    const cq = { id: 'cq', data: 'pp:0', message: { message_id: 7, date: now / 1000, chat: { id: 42 } } };
    expect(await rejectExpiredUI(cq, env, session)).toBe(true);
    expect(session.pendingMessage).toBe('new task');
    expect(env.SESSIONS.put).not.toHaveBeenCalled();
    expect(await rejectExpiredUI({ ...cq, message: { ...cq.message, message_id: 8 } }, env, session)).toBe(false);
  });
  it('does not reject a freshly-shown pp:/sp: picker whose KV session write has not propagated yet', async () => {
    // Simulates Workers KV eventual consistency: the write that stored pendingMessage
    // (from the message that triggered this picker) hasn't reached this colo yet, so the
    // session read here looks empty even though nothing actually expired or superseded it.
    const cq = { id: 'cq', data: 'pp:0', message: { message_id: 7, date: now / 1000, chat: { id: 42 } } };
    expect(await rejectExpiredUI(cq, env, null)).toBe(false);
    expect(requests).toHaveLength(0);
  });
  it('still rejects an old pp:/sp: picker with no pending record once KV should have caught up, even after a retry', async () => {
    const cq = { id: 'cq', data: 'pp:0', message: { message_id: 7, date: (now - KV_PROPAGATION_GRACE_MS) / 1000, chat: { id: 42 } } };
    const result = rejectExpiredUI(cq, env, null);
    await vi.advanceTimersByTimeAsync(400);
    expect(await result).toBe(true);
  });
  it('recovers a pp:/sp: picker tapped past the grace window when the retry finds the write has now propagated', async () => {
    // The age-based grace window alone would hard-reject the instant it elapses — this
    // is exactly what a real user who took longer than KV_PROPAGATION_GRACE_MS to tap
    // (or a colo whose replication simply lagged past it) used to hit. The retry gives
    // KV one more chance to catch up before this gate commits to "expired".
    const chatId = 42;
    const pendingMessageAt = now - KV_PROPAGATION_GRACE_MS - 5000;
    const cq = { id: 'cq', data: 'pp:0', message: { message_id: 7, date: pendingMessageAt / 1000, chat: { id: chatId } } };
    const result = rejectExpiredUI(cq, env, null);
    records.set(String(chatId), { pendingMessage: 'new task', pendingMessageAt });
    await vi.advanceTimersByTimeAsync(400);
    expect(await result).toBe(false);
    expect(requests).toHaveLength(0);
  });
  describe('projectChoiceExpired (pc: picker)', () => {
    it('is not expired for a freshly-shown picker with no propagated record yet', () => {
      const cq = { message: { message_id: 7, date: now / 1000 } };
      expect(projectChoiceExpired(null, cq)).toBe(false);
    });
    it('is expired for an old picker with no record once KV should have caught up', () => {
      const cq = { message: { message_id: 7, date: (now - KV_PROPAGATION_GRACE_MS) / 1000 } };
      expect(projectChoiceExpired(null, cq)).toBe(true);
    });
    it('is not expired while messageId has not been filled in yet, within the grace window', () => {
      const pending = { createdAt: now, messageId: null };
      const cq = { message: { message_id: 7, date: now / 1000 } };
      expect(projectChoiceExpired(pending, cq)).toBe(false);
    });
    it('is expired immediately for a genuinely different (already-populated) messageId', () => {
      const pending = { createdAt: now, messageId: 9 };
      const cq = { message: { message_id: 7, date: now / 1000 } };
      expect(projectChoiceExpired(pending, cq)).toBe(true);
    });
    it('is expired immediately when dispatching or suspended, regardless of grace', () => {
      const cq = { message: { message_id: 7, date: now / 1000 } };
      expect(projectChoiceExpired({ createdAt: now, messageId: 7, dispatching: true }, cq)).toBe(true);
      expect(projectChoiceExpired({ createdAt: now, messageId: 7, suspended: true }, cq)).toBe(true);
    });
    it('is expired once past PICKER_TTL_MS, regardless of grace', () => {
      const pending = { createdAt: now - PICKER_TTL_MS, messageId: 7 };
      const cq = { message: { message_id: 7, date: now / 1000 } };
      expect(projectChoiceExpired(pending, cq)).toBe(true);
    });
  });
});


describe('production wiring', () => {
  it('the scheduled entrypoint drains expired UI, even with no user traffic', async () => {
    const worker = (await import('../src/index.js')).default;
    await trackUI(env, 42, 7, keyboard('pp:0'), now - PICKER_TTL_MS);
    const jobs = [];
    await worker.scheduled({}, env, { waitUntil: promise => jobs.push(promise) });
    await Promise.all(jobs);
    expect(requests.some(r => r.method === 'deleteMessage')).toBe(true);
    expect(records.size).toBe(0);
  });
  it.each([42, -10042])('real callback handler rejects expired project selection in chat %s', async chatId => {
    const { handleCallbackQuery } = await import('../src/handlers/callbacks.js');
    records.set(String(chatId), { username: 'u', pendingMessage: 'new task', pendingMessageAt: now });
    await handleCallbackQuery({ id: 'cq', data: 'pp:0', message: { chat: { id: chatId }, message_id: 7, date: (now - PICKER_TTL_MS) / 1000 } }, env);
    expect(requests.map(r => r.method)).toEqual(['answerCallbackQuery', 'deleteMessage']);
    expect(records.get(String(chatId)).pendingMessage).toBe('new task');
  });
});
