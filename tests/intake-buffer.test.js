import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock every module the DO pulls in so the state machine runs in isolation.
const handleMessage = vi.fn();
const sendMessage = vi.fn();
const sendMessageWithKeyboard = vi.fn();
const editMessage = vi.fn();
const editMessageReplyMarkup = vi.fn();

vi.mock('../src/handlers/message.js', () => ({ handleMessage: (...a) => handleMessage(...a) }));
vi.mock('../src/lib/telegram.js', () => ({
  sendMessage: (...a) => sendMessage(...a),
  sendMessageWithKeyboard: (...a) => sendMessageWithKeyboard(...a),
  editMessage: (...a) => editMessage(...a),
  editMessageReplyMarkup: (...a) => editMessageReplyMarkup(...a),
}));

import { IntakeBuffer } from '../src/intake-buffer.js';

// Minimal in-memory DurableObjectState.storage + single alarm slot.
function makeState() {
  const map = new Map();
  let alarm = null;
  return {
    storage: {
      async get(k) { return map.has(k) ? map.get(k) : undefined; },
      async put(k, v) { map.set(k, v); },
      async delete(k) { map.delete(k); },
      async getAlarm() { return alarm; },
      async setAlarm(t) { alarm = t; },
      async deleteAlarm() { alarm = null; },
    },
    _dump: () => ({ map, alarm }),
  };
}

function appendReq(text, flush = false) {
  return new Request('https://intake/append', {
    method: 'POST',
    body: JSON.stringify({ text, msg: { chat: { id: 42 }, text }, flush }),
  });
}
const flushReq = () => new Request('https://intake/flush', { method: 'POST' });

// Let dynamic import() inside _dispatch settle across a few macrotasks.
async function drain() { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); }

beforeEach(() => {
  vi.clearAllMocks();
  sendMessage.mockResolvedValue({ ok: true, result: { message_id: 98 } });
  sendMessageWithKeyboard.mockResolvedValue({ ok: true, result: { message_id: 99 } });
  editMessage.mockResolvedValue({ ok: true });
  editMessageReplyMarkup.mockResolvedValue({ ok: true });
});

describe('IntakeBuffer — manual accumulator (no timer)', () => {
  it('idle messages each get a FRESH anchored ack, never a silent edit (owner reversal 2026-09-15)', async () => {
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });

    await io.fetch(appendReq('start the task'));
    expect(handleMessage).not.toHaveBeenCalled();
    expect(state._dump().alarm).toBeNull();                 // no timer armed
    expect(sendMessageWithKeyboard).toHaveBeenCalledTimes(1); // collector shown
    expect(editMessageReplyMarkup).not.toHaveBeenCalled();    // nothing prior to strip

    // Second message must produce its OWN fresh bubble (anchored to it), not an
    // edit of the first — an edit is invisible once the chat has scrolled past it.
    await io.fetch(appendReq('also do X'));
    expect(handleMessage).not.toHaveBeenCalled();
    expect(editMessage).not.toHaveBeenCalled();
    expect(sendMessageWithKeyboard).toHaveBeenCalledTimes(2); // a new collector each time
    expect(editMessageReplyMarkup).toHaveBeenCalledTimes(1);  // prior button stripped
  });

  it('▶️ flush coalesces the buffer into ONE dispatch and clears busy after', async () => {
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });

    await io.fetch(appendReq('start the task'));
    await io.fetch(appendReq('also do X'));

    await io.fetch(flushReq());
    await drain();

    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(handleMessage.mock.calls[0][0].text).toBe('start the task\nalso do X');
    // §A #530: launching the buffer starts a DEEP (проработка) session, not a one-shot.
    // initialMsgId is the fresh placeholder (sendMessage → 98), NOT the old collector (99),
    // so the agent response always appears below any voice transcript already posted.
    expect(handleMessage.mock.calls[0][2]).toEqual({ mode: 'deep', initialMsgId: 98 });
    expect(await state.storage.get('busy')).toBeUndefined();
    expect(await state.storage.get('buf')).toBeUndefined();
  });

  it('a force word (flush:true) launches immediately without a button tap', async () => {
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });

    await io.fetch(appendReq('do the thing', true));
    await drain();

    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(handleMessage.mock.calls[0][0].text).toBe('do the thing');
    // Force word path: no prior collector, but a fresh placeholder is still sent (sendMessage → 98).
    expect(handleMessage.mock.calls[0][2]).toEqual({ mode: 'deep', initialMsgId: 98 });
  });

  it('holds messages sent during a run and re-offers a button afterwards (no auto-run)', async () => {
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });

    await io.fetch(appendReq('start the task'));

    let release;
    handleMessage.mockReturnValueOnce(new Promise(r => { release = r; }));
    const runPromise = io.fetch(flushReq());
    await drain();
    expect(handleMessage).toHaveBeenCalledTimes(1);

    // Messages sent WHILE the run is in flight are buffered, not dispatched.
    await io.fetch(appendReq('actually also do X'));
    await io.fetch(appendReq('and Y'));
    expect(handleMessage).toHaveBeenCalledTimes(1);

    release();
    await runPromise;

    // Run done: held messages are NOT auto-dispatched — a fresh button is shown.
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(await state.storage.get('busy')).toBeUndefined();
    expect(sendMessageWithKeyboard).toHaveBeenCalledTimes(2); // collector re-offered
    expect((await state.storage.get('buf')).length).toBe(2);
  });

  it('falls back to a plain-text ack when the keyboard send is rejected (#595)', async () => {
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });

    // Telegram rejects the keyboard message (e.g. bad markup) — must not leave
    // the user with zero ack even though the message itself was buffered fine.
    sendMessageWithKeyboard.mockResolvedValueOnce({ ok: false, description: 'Bad Request: reply markup' });
    sendMessage.mockResolvedValueOnce({ ok: true, result: { message_id: 55 } });

    await io.fetch(appendReq('start the task'));

    expect(sendMessageWithKeyboard).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1); // plain-text retry fired
    expect(await state.storage.get('collectorMsgId')).toBe(55);
  });

  it('recovers a buffer trapped by a dead run once BUSY_MAX elapses', async () => {
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });

    // Simulate an isolate that died mid-run: busy set long ago, messages waiting.
    await state.storage.put('busy', true);
    await state.storage.put('busySince', 1); // effectively "ages ago"
    await state.storage.put('buf', [{ text: 'hello', msg: { chat: { id: 42 }, text: 'hello' } }]);

    await io.alarm();

    // Hold released; stranded message surfaced with a button, never auto-run.
    expect(await state.storage.get('busy')).toBeUndefined();
    expect(handleMessage).not.toHaveBeenCalled();
    expect(sendMessageWithKeyboard).toHaveBeenCalledTimes(1);
  });
});


describe('intake concurrent delivery', () => {
  it('five overlapping appends and a double launch retain all messages exactly once', async () => {
    const state = makeState();
    // Real storage returns detached values, not a shared mutable JS array.
    const get = state.storage.get;
    state.storage.get = async key => structuredClone(await get(key));
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });
    await Promise.all([5, 2, 4, 1, 3].map(id => io.fetch(new Request('https://intake/append', {
      method: 'POST', body: JSON.stringify({ text: `question ${id}`, msg: { chat: { id: 42 }, message_id: id } }),
    }))));
    await Promise.all([io.fetch(flushReq()), io.fetch(flushReq())]);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(handleMessage.mock.calls[0][0].intakeItems.map(i => i.msg.message_id)).toEqual([1, 2, 3, 4, 5]);
  });
});


it('recovers the persisted launch after isolate loss without auto-running it', async () => {
  const state = makeState();
  await state.storage.put('busy', true);
  await state.storage.put('busySince', Date.now() - 46 * 60_000);
  await state.storage.put('launching', [{ text: 'original', msg: { chat: { id: 42 }, message_id: 1 } }]);
  await state.storage.put('buf', [{ text: 'new', msg: { chat: { id: 42 }, message_id: 2 } }]);
  const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });
  await io.alarm();
  expect((await state.storage.get('retryBatch')).map(i => i.text)).toEqual(['original']);
  expect((await state.storage.get('buf')).map(i => i.text)).toEqual(['new']);
  expect(handleMessage).not.toHaveBeenCalled();
  expect(await state.storage.get('launching')).toBeUndefined();
});

 it('preparation failure retains original batch and reports media failure, not missing launch ACK', async () => {
   const state = makeState(); const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });
   const original = { text: 'screenshot', msg: { chat: { id: 42 }, message_id: 123, photo: [{ file_id: 'original' }] } };
   await state.storage.put('buf', [original]);
   handleMessage.mockRejectedValueOnce(Object.assign(new Error('upload failed'), { code: 'INTAKE_PREPARATION_FAILED' }));
   await io.fetch(flushReq());
   expect(await state.storage.get('retryBatch')).toEqual([original]);
   const warning = sendMessage.mock.calls.find(call => String(call[2]).includes('Не удалось подготовить вложение'));
   expect(warning).toBeTruthy();
   expect(warning[2]).not.toContain('Подтверждение запуска');
   handleMessage.mockResolvedValueOnce(undefined);
   await io.fetch(flushReq());
   expect(await state.storage.get('retryBatch')).toBeUndefined();
 });
