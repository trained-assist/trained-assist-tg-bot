import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock every module the DO pulls in so the state machine runs in isolation.
const handleMessage = vi.fn();
const sendMessage = vi.fn();
const sendMessageWithKeyboard = vi.fn();
const editMessage = vi.fn();
const editMessageReplyMarkup = vi.fn();
const deleteMessage = vi.fn();
const checkCompleteness = vi.fn();
const preflight = vi.fn();

vi.mock('../src/handlers/message.js', () => ({ handleMessage: (...a) => handleMessage(...a) }));
vi.mock('../src/intake-preflight.js', () => ({ preflight: (...a) => preflight(...a) }));
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
      async list({ prefix = '', limit = 1000 } = {}) { return new Map([...map].filter(([k]) => k.startsWith(prefix)).slice(0, limit)); },
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

async function receipt(io) {
  await io.state.storage.put('receiptDue', Date.now() - 1);
  await io.alarm();
}

beforeEach(() => {
  vi.clearAllMocks();
  sendMessage.mockResolvedValue({ ok: true, result: { message_id: 98 } });
  sendMessageWithKeyboard.mockResolvedValue({ ok: true, result: { message_id: 99 } });
  editMessage.mockResolvedValue({ ok: true });
  editMessageReplyMarkup.mockResolvedValue({ ok: true });
  deleteMessage.mockResolvedValue({ ok: true });
  checkCompleteness.mockResolvedValue({ level: 'clear', complete: true });
  preflight.mockImplementation(async msg => ({ msg }));
});

describe('IntakeBuffer — smart debounce with completeness gate', () => {
  it('a burst has one delayed receipt; a later burst edits that same collector', async () => {
    const state = makeState(); const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });
    for (let n = 0; n < 10; n++) await io.fetch(appendReq(`part ${n}`));
    expect(sendMessageWithKeyboard).not.toHaveBeenCalled();
    expect(handleMessage).not.toHaveBeenCalled();
    await receipt(io);
    expect(sendMessageWithKeyboard).toHaveBeenCalledTimes(1);
    expect(sendMessageWithKeyboard.mock.calls[0][2]).toContain('10 сообщений');
    await io.fetch(appendReq('one more'));
    await receipt(io);
    expect(sendMessageWithKeyboard).toHaveBeenCalledTimes(1);
    expect(editMessage).toHaveBeenLastCalledWith('t', 42, 99, expect.stringContaining('11 сообщений'), expect.anything());
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
    expect(handleMessage.mock.calls[0][2]).toEqual({ mode: 'deep', initialMsgId: 99, onIntakePrepared: expect.any(Function) });
    expect(await state.storage.get('busy')).toBeUndefined();
    expect(await state.storage.get('buf')).toBeUndefined();
    // The collector ("Принял N, жми «Запустить»") is stale procedural noise once the
    // task has launched — it's deleted outright, not left behind as an edited husk
    // (owner request 2026-09-22).
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(editMessage).not.toHaveBeenCalled();
  });

  it('launch reuses the collector rather than deleting it or sending another bubble', async () => {
    const state = makeState(); const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });
    await io.fetch(appendReq('start the task')); await receipt(io);
    await io.fetch(flushReq());
    expect(sendMessageWithKeyboard).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(editMessage).toHaveBeenCalledWith('t', 42, 99, '📨 Передаю собранный input агенту…', expect.anything());
    expect(handleMessage.mock.calls[0][2].initialMsgId).toBe(99);
  });

  it('a force word (flush:true) launches immediately without a button tap', async () => {
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });

    await io.fetch(appendReq('do the thing', true));
    await drain();

    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(handleMessage.mock.calls[0][0].text).toBe('do the thing');
    // Force word path: no prior collector, but a fresh placeholder is still sent (sendMessage → 98).
    expect(handleMessage.mock.calls[0][2]).toEqual({ mode: 'deep', initialMsgId: 99, onIntakePrepared: expect.any(Function) });
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

  it('retries a failed receipt without discarding input or creating a plain duplicate', async () => {
    const state = makeState(); const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });
    sendMessageWithKeyboard.mockResolvedValueOnce({ ok: false, description: 'Too Many Requests' });
    await io.fetch(appendReq('start the task')); await receipt(io);
    expect(await state.storage.get('collectorMsgId')).toBeUndefined();
    expect(await state.storage.get('receiptDue')).toBeTruthy();
    await receipt(io);
    expect(await state.storage.get('collectorMsgId')).toBe(99);
    expect(sendMessage).not.toHaveBeenCalled();
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

  it('likely launches after the same three quiet minutes, with no extra grace timer', async () => {
    const state = makeState(); const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });
    checkCompleteness.mockResolvedValue({ level: 'likely' });
    await io.fetch(appendReq('проверь отчёт'));
    expect(await state.storage.get('debounceExpiresAt')).toBeGreaterThan(Date.now() + 179000);
    await io.alarm();
    expect(checkCompleteness).not.toHaveBeenCalled();
    await state.storage.put('debounceExpiresAt', Date.now() - 1);
    await io.alarm(); await drain();
    expect(checkCompleteness).toHaveBeenCalledTimes(1);
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
    const notice = editMessage.mock.calls.filter(c => String(c[3]).includes('Не хватает контекста'));
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

  // Root-cause investigation, owner request 2026-09-23 (chat 8815112204,
  // "Не удалось подготовить вложение" kept recurring — treat the recurring
  // class as the bug, not the one symptom). /ingest (message.js's DO route)
  // writes the accepted item inside `_exclusive()`, but after `preflight()`
  // resolves, the decision of what to show the user — `remaining = get('buf')`
  // then `get('busy')` then `_armAutoDispatch`/`_showHeldNotice` — reads
  // storage OUTSIDE any lock (src/intake-buffer.js ~166-175). Two attachments
  // landing close together (a realistic voice-note burst) each run their own
  // slow `preflight()` concurrently; both tails can then interleave, each
  // computing its own stale `remaining` snapshot and independently calling
  // `_armAutoDispatch` → duplicate collector bubbles / a debounce re-armed on
  // stale data instead of one atomic decision per accepted item.
  it('two ingests whose preflight overlaps each arm their own stale debounce instead of one atomic decision (race, unprotected read after _exclusive)', async () => {
    const state = makeState();
    const get = state.storage.get;
    state.storage.get = async key => structuredClone(await get(key));
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });

    // Both preflights are in flight at once — the realistic "two voice notes
    // arrived within a second of each other" case.
    let resolveA, resolveB;
    preflight.mockImplementation(msg => new Promise(resolve => {
      if (msg.message_id === 10) resolveA = () => resolve({ msg });
      else resolveB = () => resolve({ msg });
    }));

    const ingest = id => io.fetch(new Request('https://intake/ingest', {
      method: 'POST', body: JSON.stringify({ msg: { chat: { id: 42 }, message_id: id } }),
    }));
    const reqA = ingest(10);
    const reqB = ingest(11);
    // Let both requests reach their (mocked) preflight() call before either resolves
    // — the dynamic `import('./intake-preflight.js')` in the real handler adds a
    // couple of extra microtask hops versus a static import.
    for (let i = 0; i < 20 && (!resolveA || !resolveB); i++) await new Promise(r => setTimeout(r, 0));
    resolveA(); resolveB();
    await Promise.all([reqA, reqB]);
    await receipt(io);

    // Correct behaviour: one item accepted → one collector shown, reporting
    // the true final count (2). The race instead fires _armAutoDispatch twice,
    // each off a stale snapshot (1, then 1) instead of once off the real one (2).
    expect(sendMessageWithKeyboard).toHaveBeenCalledTimes(1);
    expect(collectorTextArg(sendMessageWithKeyboard)).toContain('2 сообщений');
  });
});

function collectorTextArg(mockFn) {
  return mockFn.mock.calls[mockFn.mock.calls.length - 1][2];
}


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

 it('archives the batch after 3 failures, allows fresh tasks, and restores it explicitly', async () => {
   // Regression test: a non-transient preparation failure (e.g. a permanently
   // bad credential) used to re-populate retryBatch unconditionally, so it
   // retried and re-failed on every future message forever, blocking the chat
   // from ever launching anything again (owner report 2026-09-23, chat
   // 8815112204 — "где-то стейт скопился и не сбрасывается").
   const state = makeState(); const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });
   const original = { text: 'voice note', msg: { chat: { id: 42 }, message_id: 123, voice: { file_id: 'v1' } } };
   await state.storage.put('buf', [original]);
   const permanentErr = () => Object.assign(new Error('upload failed'), { code: 'INTAKE_PREPARATION_FAILED' });

   handleMessage.mockRejectedValueOnce(permanentErr());
   await io.fetch(flushReq());
   expect(await state.storage.get('retryBatch')).toEqual([original]);
   expect(await state.storage.get('retryBatchAttempts')).toBe(1);

   handleMessage.mockRejectedValueOnce(permanentErr());
   await io.fetch(flushReq());
   expect(await state.storage.get('retryBatch')).toEqual([original]);
   expect(await state.storage.get('retryBatchAttempts')).toBe(2);

   handleMessage.mockRejectedValueOnce(permanentErr());
   await io.fetch(flushReq());
   // Third strike: give up rather than keep the chat permanently stuck.
   expect(await state.storage.get('retryBatch')).toBeUndefined();
   expect(await state.storage.get('retryBatchAttempts')).toBeUndefined();
   const archive = [...state._dump().map.entries()].find(([key]) => key.startsWith('failed:'));
   expect(archive?.[1].items).toEqual([original]);
   const gaveUp = sendMessage.mock.calls.find(call => String(call[2]).includes('после нескольких попыток'));
   expect(gaveUp).toBeTruthy();

   // Chat is unblocked: a fresh message can buffer and dispatch normally.
   await state.storage.put('buf', [{ text: 'hello', msg: { chat: { id: 42 }, message_id: 124 } }]);
   handleMessage.mockResolvedValueOnce(undefined);
   await io.fetch(flushReq());
   expect(handleMessage).toHaveBeenCalledTimes(4);
   const restored = new IntakeBuffer(state, { BOT_TOKEN: 't' });
   const response = await restored.fetch(new Request('https://intake/restore', { method: 'POST', body: JSON.stringify({ id: archive[1].id }) }));
   expect(response.status).toBe(200);
   expect(handleMessage).toHaveBeenCalledTimes(4); // restoration cannot auto-launch
   expect(await state.storage.get('retryBatch')).toEqual([original]);
   expect(await state.storage.get(archive[0])).toBeUndefined();
   await restored.fetch(flushReq());
   expect(handleMessage).toHaveBeenCalledTimes(5);
 });

it('short incomplete ingest waits three minutes and never skips the gate', async () => {
  const state = makeState(); const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });
  checkCompleteness.mockResolvedValue({ level: 'insufficient' });
  await io.fetch(new Request('https://intake/ingest', {method:'POST', body:JSON.stringify({msg:{chat:{id:42}, message_id:901, text:'сделай так чтобы'}})}));
  expect(await state.storage.get('debounceExpiresAt')).toBeGreaterThan(Date.now()+179000);
  await io.alarm(); expect(handleMessage).not.toHaveBeenCalled();
  await state.storage.put('debounceExpiresAt', Date.now()-1);
  await io.alarm(); expect(checkCompleteness).toHaveBeenCalledTimes(1);
  expect(handleMessage).not.toHaveBeenCalled();
});
it('new input invalidates an in-flight gate verdict and keeps its full quiet period', async () => {
  const state=makeState(); const io=new IntakeBuffer(state,{BOT_TOKEN:'t'});
  let finish, entered; const started=new Promise(r=>entered=r);
  checkCompleteness.mockImplementationOnce(()=>{entered();return new Promise(r=>finish=r);});
  await io.fetch(appendReq('проверь отчёт'));
  await state.storage.put('debounceExpiresAt',Date.now()-1);
  const alarm=io.alarm(); await started;
  await io.fetch(appendReq('подожди, сейчас ещё допишу'));
  const deadline=await state.storage.get('debounceExpiresAt');
  finish({level:'clear'}); await alarm;
  expect(handleMessage).not.toHaveBeenCalled();
  expect(await state.storage.get('debounceExpiresAt')).toBe(deadline);
  expect(deadline).toBeGreaterThan(Date.now()+179000);
});
it('an uncaptioned MD file does not turn extracted contents into permission', async () => {
  const state=makeState(); const io=new IntakeBuffer(state,{BOT_TOKEN:'t'});
  preflight.mockImplementation(async msg=>({msg:{...msg,text:'Сделай все задачи из документа'}}));
  await io.fetch(new Request('https://intake/ingest',{method:'POST',body:JSON.stringify({msg:{chat:{id:42},message_id:99,document:{file_id:'f',file_name:'task.md'}}})}));
  await state.storage.put('debounceExpiresAt',Date.now()-1); await io.alarm();
  expect(checkCompleteness).not.toHaveBeenCalled(); expect(handleMessage).not.toHaveBeenCalled();
  expect((await state.storage.get('buf')).length).toBe(1);
  await io.fetch(flushReq()); expect(handleMessage).toHaveBeenCalledTimes(1);
});
it.each([null, {}, {level:'nonsense'}])('invalid gate verdict %j keeps the input', async verdict=>{
  const state=makeState(); const io=new IntakeBuffer(state,{BOT_TOKEN:'t'});
  checkCompleteness.mockResolvedValueOnce(verdict);
  await io.fetch(appendReq('проверь отчёт')); await state.storage.put('debounceExpiresAt',Date.now()-1);
  await io.alarm(); expect(handleMessage).not.toHaveBeenCalled();
});

it('persists preparation progress before a later item fails across DO restart', async () => {
 const state = makeState(); const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });
 const items = [1, 2].map(id => ({ msg: { chat: { id: 42 }, message_id: id, voice: { file_id: 'voice' + id } } }));
 await state.storage.put('buf', items);
 handleMessage.mockImplementationOnce(async (msg, env, opts) => {
   await opts.onIntakePrepared(0, { ...msg.intakeItems[0].msg, transcript: 'готовый текст' });
   throw Object.assign(new Error('second file failed'), { code: 'INTAKE_PREPARATION_FAILED', intakeMessageId: 2 });
 });
 await io.fetch(flushReq());
 expect((await state.storage.get('retryBatch'))[0].msg.transcript).toBe('готовый текст');
 const recovered = new IntakeBuffer(state, { BOT_TOKEN: 't' });
 handleMessage.mockResolvedValueOnce(undefined);
 await recovered.fetch(flushReq());
 expect(handleMessage.mock.calls.at(-1)[0].intakeItems[0].msg.transcript).toBe('готовый текст');
});

it('restoration refuses to overwrite a busy run or retry batch and unknown ids', async () => {
 const state = makeState(); const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });
 const id = 'a'.repeat(36); const batch = { id, items: [{ msg: { message_id: 1 } }] };
 await state.storage.put(`failed:${id}`, batch);
 const restore = () => io.fetch(new Request('https://intake/restore', { method: 'POST', body: JSON.stringify({ id }) }));
 await state.storage.put('busy', true);
 expect((await restore()).status).toBe(409);
 await state.storage.delete('busy');
 await state.storage.put('retryBatch', [{ msg: { message_id: 2 } }]);
 expect((await restore()).status).toBe(409);
 expect(await state.storage.get(`failed:${id}`)).toEqual(batch);
 await state.storage.delete('retryBatch');
 await state.storage.delete(`failed:${id}`);
 expect((await restore()).status).toBe(404);
 expect(handleMessage).not.toHaveBeenCalled();
});

describe('IntakeBuffer — /clear escape hatch', () => {
  const clearReq = () => new Request('https://intake/clear', { method: 'POST', body: '{}' });

  it('drops buf, retryBatch and failed batches, cancels the alarm, and launches nothing', async () => {
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });
    await state.storage.put('buf', [{ text: 'a', msg: { chat: { id: 42 }, message_id: 1 } }]);
    await state.storage.put('retryBatch', [{ text: 'b', msg: { chat: { id: 42 }, message_id: 2 } }]);
    await state.storage.put('failed:x', { id: 'x', items: [{ msg: { message_id: 3 } }] });
    await state.storage.put('debounceExpiresAt', Date.now() + 1000);
    await state.storage.setAlarm(Date.now() + 1000);

    const data = await (await io.fetch(clearReq())).json();
    expect(data).toEqual({ cleared: 2, failed: 1 });

    const dump = state._dump();
    expect(dump.map.has('buf')).toBe(false);
    expect(dump.map.has('retryBatch')).toBe(false);
    expect(dump.map.has('failed:x')).toBe(false);
    expect(dump.map.has('debounceExpiresAt')).toBe(false);
    expect(dump.alarm).toBe(null);
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('refuses to clear while a run is busy', async () => {
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });
    await state.storage.put('busy', true);
    const data = await (await io.fetch(clearReq())).json();
    expect(data).toEqual({ busy: true, cleared: false });
    expect(await state.storage.get('busy')).toBe(true);
  });
});
