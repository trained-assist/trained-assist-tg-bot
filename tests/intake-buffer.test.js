import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock every module the DO pulls in so the state machine runs in isolation.
const handleMessage = vi.fn();
const sendMessage = vi.fn();
const sendMessageWithKeyboard = vi.fn();
const editMessage = vi.fn();
const editMessageReplyMarkup = vi.fn();
const deleteMessage = vi.fn();
const checkCompleteness = vi.fn();

vi.mock('../src/handlers/message.js', () => ({ handleMessage: (...a) => handleMessage(...a) }));
vi.mock('../src/lib/telegram.js', () => ({
  sendMessage: (...a) => sendMessage(...a),
  sendMessageWithKeyboard: (...a) => sendMessageWithKeyboard(...a),
  editMessage: (...a) => editMessage(...a),
  editMessageReplyMarkup: (...a) => editMessageReplyMarkup(...a),
  deleteMessage: (...a) => deleteMessage(...a),
}));
vi.mock('../src/lib/agent-client.js', () => ({
  checkCompleteness: (...a) => checkCompleteness(...a),
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
      // Real DurableObjectStorage#transaction hands the callback a tx with the
      // same get/put/setAlarm surface; this in-memory fake has no rollback
      // semantics to offer, so it just runs the callback against itself.
      async transaction(fn) {
        return fn(this);
      },
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
  deleteMessage.mockResolvedValue({ ok: true });
  checkCompleteness.mockResolvedValue({ level: 'clear', complete: true });
});

describe('IntakeBuffer — smart debounce with completeness gate', () => {
  it('idle messages each get a FRESH anchored ack, never a silent edit (owner reversal 2026-09-15)', async () => {
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });

    await io.fetch(appendReq('start the task'));
    expect(handleMessage).not.toHaveBeenCalled();
    expect(state._dump().alarm).not.toBeNull();              // debounce timer armed
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
    // The collector ("Принял N, жми «Запустить»") is stale procedural noise once the
    // task has launched — it's deleted outright, not left behind as an edited husk
    // (owner request 2026-09-22).
    expect(deleteMessage).toHaveBeenCalledWith('t', 42, 99);
    expect(editMessage).not.toHaveBeenCalled();
  });

  it('falls back to a neutral edit of the collector if the placeholder send fails', async () => {
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });

    await io.fetch(appendReq('start the task'));
    sendMessage.mockResolvedValueOnce(null); // placeholder delivery fails

    await io.fetch(flushReq());
    await drain();

    // No usable placeholder id — the collector must stay around (edited, button
    // stripped) as the fallback streaming target, not be deleted out from under it.
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(editMessage).toHaveBeenCalledWith('t', 42, 99, '▶️ Запустил проработку',
      expect.objectContaining({ reply_markup: { inline_keyboard: [] } }));
    expect(handleMessage.mock.calls[0][2]).toEqual({ mode: 'deep', initialMsgId: 99 });
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

  it('auto-dispatches after DEBOUNCE_MS when the gate says "clear"', async () => {
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });

    checkCompleteness.mockResolvedValue({ level: 'clear', complete: true });

    await io.fetch(appendReq('do the thing'));
    expect(state._dump().alarm).not.toBeNull(); // debounce armed

    // Simulate the debounce timer elapsing by back-dating it.
    await state.storage.put('debounceExpiresAt', Date.now() - 1);

    await io.alarm();
    await drain();

    expect(checkCompleteness).toHaveBeenCalledTimes(1);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(handleMessage.mock.calls[0][0].text).toBe('do the thing');
  });

  it('"likely" tells the user and waits LIKELY_AUTOLAUNCH_MS before dispatching, not the button-only fallback', async () => {
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });

    checkCompleteness.mockResolvedValue({ level: 'likely', complete: true });

    await io.fetch(appendReq('наверное это всё'));
    await state.storage.put('debounceExpiresAt', Date.now() - 1);
    await io.alarm();

    // Not dispatched yet — status message sent, gate decision persisted, a
    // (longer) alarm is re-armed instead of trapping the user behind a dead end.
    expect(handleMessage).not.toHaveBeenCalled();
    const likelyCalls = sendMessage.mock.calls.filter(c => String(c[2]).includes('через'));
    expect(likelyCalls.length).toBe(1);
    expect(await state.storage.get('gateLevel')).toBe('likely');
    expect(state._dump().alarm).not.toBeNull();

    // Grace period elapses with no further input — now it dispatches.
    await state.storage.put('debounceExpiresAt', Date.now() - 1);
    await io.alarm();
    await drain();
    expect(checkCompleteness).toHaveBeenCalledTimes(1); // gate consulted once, not re-asked
    expect(handleMessage).toHaveBeenCalledTimes(1);
  });

  it('"insufficient" never auto-dispatches — says so plainly and leaves the button, no force-fallback', async () => {
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });

    checkCompleteness.mockResolvedValue({ level: 'insufficient', complete: false });

    await io.fetch(appendReq('сделай так чтобы'));
    await state.storage.put('debounceExpiresAt', Date.now() - 1);
    await io.alarm();

    expect(handleMessage).not.toHaveBeenCalled();
    expect(checkCompleteness).toHaveBeenCalledTimes(1);
    const notice = sendMessage.mock.calls.filter(c => String(c[2]).includes('не хватает контекста'));
    expect(notice.length).toBe(1);
    // No re-armed alarm and no gate-decision to resume from — only a new
    // message or the ▶️ button can move this forward.
    expect(await state.storage.get('gateLevel')).toBeUndefined();
    expect(await state.storage.get('debounceExpiresAt')).toBeUndefined();

    // Confirm the old "force-dispatch after a grace period" fallback is gone:
    // even a later alarm fire (no new debounce armed) must not launch it.
    await io.alarm();
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('cancels a pending gate decision when a new message arrives before its timer fires', async () => {
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });

    // Simulate: previous debounce fired and the gate said "likely", timer still pending.
    await state.storage.put('gateLevel', 'likely');
    await state.storage.put('buf', [{ text: 'partial', msg: { chat: { id: 42 }, text: 'partial', message_id: 1 } }]);

    // New message arrives — should reset the gate decision and re-arm the debounce.
    await io.fetch(appendReq('completed thought'));

    expect(await state.storage.get('gateLevel')).toBeUndefined();
    expect(state._dump().alarm).not.toBeNull(); // new debounce armed
  });

  it('a resolved media item (transcript in) arms auto-dispatch — a buffer ending in media is no longer button-only forever', async () => {
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });

    await state.storage.put('buf', [{
      text: undefined,
      msg: { chat: { id: 42 }, message_id: 7, mediaJob: 'job-1' },
      mediaPending: true,
      mediaOwner: 'alice',
    }]);

    await io.fetch(new Request('https://intake/media-result', {
      method: 'POST',
      body: JSON.stringify({
        id: 'job-1', messageId: 7, username: 'alice',
        fileRef: { id: 'job-1', storage: 'r2' }, transcript: 'сделай отчёт по вакансии',
      }),
    }));

    // Before the fix: only a fresh collector was shown, no alarm/debounce armed —
    // this buffer could only ever be launched by tapping the button.
    expect(state._dump().alarm).not.toBeNull();
    expect(await state.storage.get('debounceExpiresAt')).toBeTruthy();
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
