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
const flushReq = (parallel = false) => new Request('https://intake/flush', { method: 'POST', ...(parallel ? { body: JSON.stringify({ parallel: true }) } : {}) });

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
  // Real handleMessage fires onRunAccepted after the agent acks (message.js
  // handleText) — that ack is what makes _dispatch KEEP busy for the run's
  // lifetime (epic #1527 PR1 / F1). Tests that need a custom flow override it.
  handleMessage.mockImplementation(async (msg, env, opts) => {
    opts?.onRunAccepted?.({ requestId: 'req-default', durable: true, taskId: 'task-default' });
  });
});

// Epic #1527: the agent's run-finished push → IntakeBuffer /run-finished.
const runFinishedReq = requestId => new Request('https://intake/run-finished', {
  method: 'POST',
  body: JSON.stringify(requestId === undefined ? {} : { requestId }),
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

  it('▶️ flush coalesces the buffer into ONE dispatch and holds busy until run-finished', async () => {
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
    expect(handleMessage.mock.calls[0][2]).toEqual({
      mode: 'deep', initialMsgId: 99,
      onRunAccepted: expect.any(Function), onIntakePrepared: expect.any(Function),
    });
    // Epic #1527 PR1 (red-first F1): the run is in flight — busy must OUTLIVE
    // the enqueue. Before this fix it was cleared in _dispatch's finally right
    // after the 202, which let a mid-run message auto-dispatch as a SECOND task.
    expect(await state.storage.get('busy')).toBe(true);
    expect(await state.storage.get('busyRequestIds')).toEqual(['req-default']);
    expect(await state.storage.get('buf')).toBeUndefined();

    // The collector ("Принял N, жми «Запустить»") is stale procedural noise once the
    // task has launched — it's deleted outright, not left behind as an edited husk
    // (owner request 2026-09-22).
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(editMessage).not.toHaveBeenCalled();

    // Agent reports the run finished → primary release signal.
    const res = await io.fetch(runFinishedReq('req-default'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ released: true });
    expect(await state.storage.get('busy')).toBeUndefined();
    expect(await state.storage.get('busyRequestIds')).toBeUndefined();
  });

  it('busy arms the per-minute poll instead of sleeping until BUSY_MAX', async () => {
    // A lost run-finished push used to hold the chat until BUSY_MAX_MS (45 min)
    // because the alarm was only ever armed at the hard cap — the /tasks/running
    // poll the comment describes never actually ran. The hold must now tick every
    // BUSY_POLL_MS so the first idle tick releases it.
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });
    const before = Date.now();
    await io.fetch(appendReq('start the task'));
    await io.fetch(flushReq());
    await drain();
    expect(await state.storage.get('busy')).toBe(true);
    const alarm = state._dump().alarm;
    expect(alarm).toBeGreaterThan(before);
    expect(alarm - before).toBeLessThanOrEqual(61_000);
  });

  it('run-finished from a FOREIGN dispatch (requestId mismatch) keeps the hold', async () => {
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });
    await io.fetch(appendReq('start the task'));
    await io.fetch(flushReq());
    await drain();
    expect(await state.storage.get('busy')).toBe(true);

    const res = await io.fetch(runFinishedReq('someone-elses-request'));
    expect(await res.json()).toMatchObject({ busy: true, mismatch: true });
    expect(await state.storage.get('busy')).toBe(true);

    // The matching one releases.
    await io.fetch(runFinishedReq('req-default'));
    expect(await state.storage.get('busy')).toBeUndefined();
  });

  it('RC-03 prep: a busy window with two live runs releases only after the LAST run finishes', async () => {
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });
    await io.fetch(appendReq('start the task'));
    await io.fetch(flushReq());
    await drain();
    expect(await state.storage.get('busy')).toBe(true);
    // The explicit parallel dispatch (Ф4/RC-03, added by the next slice) appends
    // its id — the hold must cover BOTH runs.
    await state.storage.put('busyRequestIds', ['req-default', 'req-parallel']);

    const first = await io.fetch(runFinishedReq('req-default'));
    expect(await first.json()).toMatchObject({ busy: true, stillRunning: true });
    expect(await state.storage.get('busy')).toBe(true);

    const last = await io.fetch(runFinishedReq('req-parallel'));
    expect(await last.json()).toMatchObject({ busy: false, released: true });
    expect(await state.storage.get('busy')).toBeUndefined();
  });

  it('legacy scalar busyRequestId (deploy with a run in flight) is still honoured', async () => {
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });
    await io.fetch(appendReq('start the task'));
    await io.fetch(flushReq());
    await drain();
    await state.storage.delete('busyRequestIds');
    await state.storage.put('busyRequestId', 'req-default');

    const foreign = await io.fetch(runFinishedReq('someone-elses-request'));
    expect(await foreign.json()).toMatchObject({ busy: true, mismatch: true });
    const own = await io.fetch(runFinishedReq('req-default'));
    expect(await own.json()).toMatchObject({ busy: false, released: true });
  });

  it('RC-03: «⚡ Параллельно» launches the held batch NOW as a second run of the same window', async () => {
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });
    await io.fetch(appendReq('first task'));
    await io.fetch(flushReq());
    await drain();
    expect(await state.storage.get('busy')).toBe(true); // run A owns the window

    await io.fetch(appendReq('second task during the run'));
    handleMessage.mockImplementation(async (msg, env, opts) => {
      opts?.onRunAccepted?.({ requestId: 'req-parallel', durable: true, taskId: 'task-parallel' });
    });
    const res = await (await io.fetch(flushReq(true))).json();
    expect(res).toMatchObject({ busy: true, parallel: true });
    await drain();

    // The second batch dispatches IMMEDIATELY (not queued behind run-finished)…
    expect(handleMessage).toHaveBeenCalledTimes(2);
    expect(handleMessage.mock.calls[1][2]).toMatchObject({ parallel: true, mode: 'deep' });
    // …and joins the same busy window.
    expect(await state.storage.get('busyRequestIds')).toEqual(['req-default', 'req-parallel']);

    // A finishes first — the hold must stay (P is still live).
    const first = await (await io.fetch(runFinishedReq('req-default'))).json();
    expect(first).toMatchObject({ busy: true, stillRunning: true });
    expect(await state.storage.get('busy')).toBe(true);
    // P finishes last — only now the window releases.
    const last = await (await io.fetch(runFinishedReq('req-parallel'))).json();
    expect(last).toMatchObject({ busy: false, released: true });
    expect(await state.storage.get('busy')).toBeUndefined();
  });

  it('RC-03: a parallel tap with an empty buffer is a no-op and leaves no stale intent', async () => {
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });
    await io.fetch(appendReq('first task'));
    await io.fetch(flushReq());
    await drain();
    const res = await (await io.fetch(flushReq(true))).json();
    expect(res).toEqual({ busy: true });
    expect(await state.storage.get('launchParallel')).toBeUndefined();
    expect(handleMessage).toHaveBeenCalledTimes(1); // only the first run — no new dispatch
  });

  it('«⚡ Параллельно» with attachments still downloading: intent survives until the last one lands', async () => {
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });
    await io.fetch(appendReq('first task'));
    await io.fetch(flushReq());
    await drain();
    // Second batch has a still-downloading item — the tap is remembered, not dropped.
    const items = [{ text: 'x', msg: { chat: { id: 42 }, message_id: 77, text: 'x' }, mediaPending: true }];
    await state.storage.put('buf', items);
    const res = await (await io.fetch(flushReq(true))).json();
    expect(res).toMatchObject({ busy: true, parallel: true, preparing: true });
    expect(await state.storage.get('launchParallel')).toBe(true);
    expect(await state.storage.get('launchWhenReady')).toBe(true);

    // /cancel drops the parallel intent along with the queue.
    await (await io.fetch(new Request('https://intake/cancel', { method: 'POST' }))).json();
    expect(await state.storage.get('launchParallel')).toBeUndefined();
    expect(await state.storage.get('launchWhenReady')).toBeUndefined();
  });

  it('run-finished with no active run is a harmless no-op', async () => {
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });
    const res = await io.fetch(runFinishedReq('req-x'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ busy: false });
  });

  it('dispatch that never reaches the agent (no ack) releases busy immediately', async () => {
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });
    // Project picker path: handleMessage resolves without calling onRunAccepted.
    handleMessage.mockImplementation(async () => {});
    await io.fetch(appendReq('pick a project first'));
    await io.fetch(flushReq());
    await drain();
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(await state.storage.get('busy')).toBeUndefined();
  });

  it('a dispatch that throws releases busy and restores the batch as retryable', async () => {
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });
    handleMessage.mockRejectedValueOnce(new Error('agent down'));
    await io.fetch(appendReq('do it'));
    await io.fetch(flushReq());
    await drain();
    expect(await state.storage.get('busy')).toBeUndefined();
    // The batch survived — a later flush can retry it.
    expect((await state.storage.get('retryBatch') || await state.storage.get('buf') || []).length).toBe(1);
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
    expect(handleMessage.mock.calls[0][2]).toEqual({
      mode: 'deep', initialMsgId: 99,
      onRunAccepted: expect.any(Function), onIntakePrepared: expect.any(Function),
    });
  });

  it('holds messages sent during a run; run-finished (not enqueue) re-offers the button', async () => {
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });

    await io.fetch(appendReq('start the task'));

    let release;
    handleMessage.mockImplementationOnce((msg, env, opts) => new Promise(r => {
      release = () => { opts?.onRunAccepted?.({ requestId: 'req-slow', durable: true }); r(); };
    }));
    const runPromise = io.fetch(flushReq());
    await drain();
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(await state.storage.get('busy')).toBe(true);

    // Messages sent WHILE the run is in flight are buffered, not dispatched.
    await io.fetch(appendReq('actually also do X'));
    await io.fetch(appendReq('and Y'));
    expect(handleMessage).toHaveBeenCalledTimes(1);

    // Enqueue returned — but the RUN is still going: hold stays, no button yet.
    release();
    await runPromise;
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(await state.storage.get('busy')).toBe(true);
    expect((await state.storage.get('buf')).length).toBe(2);

    // Agent pushes run-finished → hold released, held input re-offered, never auto-run.
    await io.fetch(runFinishedReq('req-slow'));
    expect(await state.storage.get('busy')).toBeUndefined();
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(sendMessageWithKeyboard).toHaveBeenCalledTimes(2); // collector re-offered
    expect((await state.storage.get('buf')).length).toBe(2);
  });

  it('launch button: нет под «задача принята», под held-порцией — явный выбор «В очередь» (Ф3)', async () => {
    // Owner 2026-09-29 01:04: «когда задача принята, надо кнопку убирать — ты не
    // думаешь, нажата она или нет» ⇒ статус «📨 Передаю собранный input агенту…»
    // без ▶️, и остаётся таким.
    // Owner 2026-09-29 04:02: «вообще нет кнопки запустить … хотя я ни разу не
    // нажимал» (issue #303) ⇒ сообщения, пришедшие ВО ВРЕМЯ прогона, — отдельная
    // порция, её квитанция несёт ▶️; тап ставит запуск в очередь на конец прогона.
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });
    // Per-mock counts, NOT one merged index: the merged array puts every send
    // before every edit, so a slice on a single counter mis-reads a phase that
    // switched from edit to send (which is exactly what the held receipt does).
    const counts = () => [sendMessageWithKeyboard.mock.calls.length, editMessage.mock.calls.length];
    const since = ([s, e]) => [
      ...sendMessageWithKeyboard.mock.calls.slice(s).map(c => c[3]),
      ...editMessage.mock.calls.slice(e).map(c => c[4]?.reply_markup?.inline_keyboard),
    ];
    const kbText = kb => JSON.stringify(kb);

    await io.fetch(appendReq('start the task'));
    await receipt(io); // idle collector, with the launch button
    expect(kbText(sendMessageWithKeyboard.mock.calls.at(-1)?.[3])).toContain('intake_run');
    expect(kbText(sendMessageWithKeyboard.mock.calls.at(-1)?.[3])).toContain('▶️ Запустить агента');

    const taken = counts();
    await io.fetch(flushReq()); await drain();
    expect(await state.storage.get('busy')).toBe(true);
    const dispatch = since(taken);
    expect(dispatch.length).toBeGreaterThan(0); // «📨 Передаю собранный input агенту…»
    for (const kb of dispatch) {
      expect(kbText(kb)).not.toContain('intake_run');
    }

    const heldStart = counts();
    await io.fetch(appendReq('held during run'));
    await receipt(io); // held receipt while the run is accepted
    const held = since(heldStart);
    expect(held.length).toBeGreaterThan(0);
    // Ф3 (RC-02): busy wording is the explicit choice — «В очередь после текущей»,
    // not the idle «Запустить агента» (whose tap starts the run itself).
    expect(held.some(kb => kbText(kb).includes('▶️ В очередь после текущей'))).toBe(true);
    expect(held.some(kb => kbText(kb).includes('▶️ Запустить агента'))).toBe(false);
    // RC-01/RC-06: the receipt spells out that nothing runs without the tap
    // (held receipt may be a fresh send or an edit of the live collector).
    const heldTexts = [
      ...sendMessageWithKeyboard.mock.calls.slice(heldStart[0]).map(c => c[2]),
      ...editMessage.mock.calls.slice(heldStart[1]).map(c => c[3]),
    ].filter(t => typeof t === 'string' && t.includes('Получил ещё'));
    expect(heldTexts.at(-1)).toContain('Решаешь ты');
    expect(heldTexts.at(-1)).toContain('сами никуда не уйдут');
    // RC-04/RC-05: both stop options are on the same receipt as the queue/parallel
    // choices — the user decides about the held input where he sees it (#316).
    expect(held.some(kb => kbText(kb).includes('Стоп и запуск с добавкой'))).toBe(true);
    expect(held.some(kb => kbText(kb).includes('Стоп → новая задача'))).toBe(true);

    const released = counts();
    await io.fetch(runFinishedReq('req-default')); await drain();
    expect(await state.storage.get('busy')).toBeUndefined();
    const afterRelease = since(released);
    expect(afterRelease.length).toBeGreaterThan(0); // held input re-offered WITH the button
    expect(afterRelease.some(kb => kbText(kb).includes('intake_run'))).toBe(true);
  });

  it('the judge sets the delay and the collector says it (30 s continuation)', async () => {
    // Owner 2026-09-29: a short «продолжай» waits 30 seconds, not three minutes —
    // and the bot says so out loud. The delay comes from the agent verdict.
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't', AGENT_URL: 'https://agent', AGENT_SECRET: 's' });
    checkCompleteness.mockResolvedValue({ level: 'continue', complete: true, delayMs: 30000, announce: '⏳ Понял — продолжаю. Запущу через 30 секунд, если не пришлёшь ничего нового.' });
    const before = Date.now();
    await io.fetch(appendReq('давай дальше'));
    await receipt(io);
    expect(checkCompleteness).toHaveBeenCalledTimes(1);
    expect(checkCompleteness.mock.calls[0][1]).toMatchObject({ text: 'давай дальше', chatId: 42 });
    const expires = await state.storage.get('debounceExpiresAt');
    expect(expires - before).toBeGreaterThan(25_000);
    expect(expires - before).toBeLessThanOrEqual(31_000);
    const texts = [
      ...sendMessageWithKeyboard.mock.calls.map(c => c[2]),
      ...editMessage.mock.calls.map(c => c[3]),
    ];
    expect(texts.some(t => String(t).includes('30 секунд'))).toBe(true);
  });

  it('▶️ tap DURING a run is not a silent no-op: queued, launched right after run-finished', async () => {
    // Owner 2026-09-27: «кнопка Запустить пропала / не запускается». The held
    // receipt showed «▶️ Запустить агента», but /flush while busy returned
    // {busy:true} and did nothing. Now the tap is remembered and honoured.
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });
    await io.fetch(appendReq('start the task'));
    await io.fetch(flushReq()); await drain();
    expect(await state.storage.get('busy')).toBe(true);

    await io.fetch(appendReq('supplement during run'));
    const tap = await (await io.fetch(flushReq())).json();
    expect(tap).toMatchObject({ busy: true, queued: true });
    expect(handleMessage).toHaveBeenCalledTimes(1); // still no concurrent run (F1)

    await io.fetch(runFinishedReq('req-default')); await drain();
    expect(handleMessage).toHaveBeenCalledTimes(2); // launched without a 2nd tap
    expect(handleMessage.mock.calls[1][0].text).toBe('supplement during run');
    expect(await state.storage.get('launchAfterRelease')).toBeUndefined();
  });

  it('a stale/duplicate tap on a run with NOTHING held reports busy, never a queued task', async () => {
    // Owner 2026-09-28 (chat -5501536471, #293): «вычисления норм пошли, но в телегу
    // упало ⏳ Идёт текущая задача. Запущу эти сообщения…». The run had already
    // swallowed its own batch, so there were no «эти сообщения» to queue: the
    // promise was false and it read like a failed launch. Arm nothing, say nothing.
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });
    await io.fetch(appendReq('start the task'));
    await io.fetch(flushReq()); await drain();
    expect(await state.storage.get('busy')).toBe(true);
    expect(await state.storage.get('buf')).toBeUndefined();

    const tap = await (await io.fetch(flushReq())).json();
    expect(tap).toEqual({ busy: true }); // no `queued` → the gateway sends no bubble
    expect(await state.storage.get('launchAfterRelease')).toBeUndefined();

    await io.fetch(runFinishedReq('req-default')); await drain();
    expect(handleMessage).toHaveBeenCalledTimes(1); // no phantom second launch
  });

  it('▶️ tap on a STALE hold (agent says nothing runs) self-heals and launches now', async () => {
    const state = makeState();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ running: false })));
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't', AGENT_URL: 'https://agent', AGENT_SECRET: 's' });
    await state.storage.put('busy', true);
    await state.storage.put('busySince', Date.now() - 5 * 60_000);
    await state.storage.put('busyChatId', 42);
    await state.storage.put('buf', [{ text: 'held', msg: { chat: { id: 42 }, text: 'held', message_id: 7 } }]);
    const tap = await (await io.fetch(flushReq())).json();
    await drain();
    expect(tap).toMatchObject({ flushed: true, healed: true });
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(handleMessage.mock.calls[0][0].text).toBe('held');
    fetchSpy.mockRestore();
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

  it('alarm poll releases a lost-push busy when the agent reports the chat idle', async () => {
    const state = makeState();
    const realFetch = global.fetch;
    const io = new IntakeBuffer(state, {
      BOT_TOKEN: 't', AGENT_URL: 'https://agent.example', AGENT_SECRET: 'sek',
    });
    await io.fetch(appendReq('start the task'));
    await io.fetch(flushReq());
    await drain();
    expect(await state.storage.get('busy')).toBe(true);

    // Warmup: a young busy must NOT poll yet (ack → agent counter visibility).
    await state.storage.put('busySince', Date.now() - 5_000);
    await io.alarm();
    expect(await state.storage.get('busy')).toBe(true);

    // Past warmup, agent says the chat has no accepted run → push was lost.
    await state.storage.put('busySince', Date.now() - 60_000);
    await state.storage.put('buf', [{ text: 'held', msg: { chat: { id: 42 }, message_id: 7, text: 'held' } }]);
    let polledUrl = null;
    global.fetch = async (url, init) => {
      polledUrl = String(url);
      expect(init.headers.Authorization).toBe('Bearer sek');
      return { ok: true, json: async () => ({ running: false, scope: 'chat' }) };
    };
    try {
      await io.alarm();
    } finally {
      global.fetch = realFetch;
    }
    expect(polledUrl).toContain('https://agent.example/tasks/running?chatId=42');
    expect(await state.storage.get('busy')).toBeUndefined();
    // Held message re-offered with the launch button.
    expect(sendMessageWithKeyboard).toHaveBeenCalledTimes(2);
  });

  it('alarm poll keeps busy while the agent still reports the chat running', async () => {
    const state = makeState();
    const realFetch = global.fetch;
    const io = new IntakeBuffer(state, {
      BOT_TOKEN: 't', AGENT_URL: 'https://agent.example', AGENT_SECRET: 'sek',
    });
    await io.fetch(appendReq('start the task'));
    await io.fetch(flushReq());
    await drain();
    await state.storage.put('busySince', Date.now() - 60_000);
    global.fetch = async () => ({ ok: true, json: async () => ({ running: true, scope: 'chat' }) });
    try {
      await io.alarm();
    } finally {
      global.fetch = realFetch;
    }
    expect(await state.storage.get('busy')).toBe(true);
  });

  it('alarm poll asks the single backend: a running run holds the chat busy (#326/#302)', async () => {
    const state = makeState();
    const realFetch = global.fetch;
    const io = new IntakeBuffer(state, {
      BOT_TOKEN: 't', AGENT_URL: 'https://agent.example', AGENT_SECRET: 'sek',
    });
    await state.storage.put('busy', true);
    await state.storage.put('busySince', Date.now() - 60_000);
    await state.storage.put('busyChatId', 42);
    const running = [];
    global.fetch = async url => {
      running.push(String(url));
      return { ok: true, json: async () => ({ running: true }) };
    };
    try {
      await io.alarm();
      expect(running.filter(u => u.includes('/tasks/running')))
        .toEqual(['https://agent.example/tasks/running?chatId=42']);
      expect(await state.storage.get('busy')).toBe(true); // still running → hold

      global.fetch = async () => ({ ok: true, json: async () => ({ running: false }) });
      await io.alarm();
      expect(await state.storage.get('busy')).toBeUndefined(); // idle → released
    } finally {
      global.fetch = realFetch;
    }
  });
  it('alarm poll is skipped for outbox dispatches (delivery not yet counted)', async () => {
    const state = makeState();
    const realFetch = global.fetch;
    let called = false;
    global.fetch = async () => { called = true; return { ok: true, json: async () => ({ running: false }) }; };
    try {
      const io = new IntakeBuffer(state, { BOT_TOKEN: 't', AGENT_URL: 'https://agent.example' });
      await state.storage.put('busy', true);
      await state.storage.put('busySince', Date.now() - 60_000);
      await state.storage.put('busyChatId', 42);
      await state.storage.put('busyViaOutbox', true);
      await io.alarm();
      expect(called).toBe(false);
      expect(await state.storage.get('busy')).toBe(true);
    } finally {
      global.fetch = realFetch;
    }
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

    // Real ingest shape (message_id present) — the notice must be anchored to the
    // user's own message so it lands right below it in the chat.
    await io.fetch(new Request('https://intake/ingest', { method: 'POST',
      body: JSON.stringify({ msg: { chat: { id: 42 }, message_id: 5, text: 'сделай так чтобы' } }) }));
    await state.storage.put('debounceExpiresAt', Date.now() - 1);
    await io.alarm();

    expect(handleMessage).not.toHaveBeenCalled();
    expect(checkCompleteness).toHaveBeenCalledTimes(1);
    // #248: the ask is a NEW bubble under the user's message, not an edit of a
    // collector that may sit far up the chat (the 02.10 silent-chat incident).
    const notice = sendMessageWithKeyboard.mock.calls.filter(c => String(c[2]).includes('Не хватает контекста'));
    expect(notice.length).toBe(1);
    expect(notice[0][4].reply_to_message_id).toBe(5);
    // The batch is parked, not stranded: a re-offer timer is armed and the state
    // is discoverable in /debug.
    expect(await state.storage.get('parkedAt')).toBeGreaterThan(0);
    expect(await state.storage.get('parkReoffers')).toBe(0);
    expect(state._dump().alarm).not.toBeNull();
    // No re-armed debounce and no gate-decision to resume from — only a new
    // message or the ▶️ button can move this forward.
    expect(await state.storage.get('gateLevel')).toBeUndefined();
    expect(await state.storage.get('debounceExpiresAt')).toBeUndefined();

    // Confirm the old "force-dispatch after a grace period" fallback is gone:
    // even a later alarm fire (no new debounce armed) must not launch it.
    await io.alarm();
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('a parked batch re-offers once, then stays parked and discoverable', async () => {
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });

    checkCompleteness.mockResolvedValue({ level: 'insufficient', complete: false });
    await io.fetch(appendReq('сделай так чтобы'));
    await state.storage.put('debounceExpiresAt', Date.now() - 1);
    await io.alarm();
    expect(sendMessageWithKeyboard.mock.calls.filter(c => String(c[2]).includes('Не хватает контекста')).length).toBe(1);

    // Past the re-offer window: one visible reminder, then quiet.
    await state.storage.put('parkedAt', Date.now() - 16 * 60_000);
    await io.alarm();
    const reminders = sendMessageWithKeyboard.mock.calls.filter(c => String(c[2]).includes('Напоминаю'));
    expect(reminders.length).toBe(1);
    expect(await state.storage.get('parkReoffers')).toBe(1);
    expect(state._dump().alarm).toBeNull();

    // Still parked, still not launched, and /debug no longer calls it stranded.
    await io.alarm();
    expect(handleMessage).not.toHaveBeenCalled();
    expect(sendMessageWithKeyboard.mock.calls.filter(c => String(c[2]).includes('Напоминаю')).length).toBe(1);
    const debug = await (await io.fetch(new Request('https://intake/debug'))).json();
    expect(debug.parkedAt).toBeGreaterThan(0);
    expect(debug.stranded).toBe(false);
  });

  it('new input clears the parked state and re-arms the normal flow', async () => {
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });

    checkCompleteness.mockResolvedValue({ level: 'insufficient', complete: false });
    await io.fetch(appendReq('сделай так чтобы'));
    await state.storage.put('debounceExpiresAt', Date.now() - 1);
    await io.alarm();
    expect(await state.storage.get('parkedAt')).toBeGreaterThan(0);

    await io.fetch(appendReq('вот продолжение задачи'));
    expect(await state.storage.get('parkedAt')).toBeUndefined();
    expect(await state.storage.get('debounceExpiresAt')).toBeGreaterThan(Date.now());
  });

  // #248: a judge that did NOT answer must not read as «недостаточно контекста»,
  // and must not consume the only timer the batch had (live dead-end 2026-09-29:
  // buffer non-empty, debounce null, no alarm, nothing ever launched).
  it('a judge failure re-arms a retry and never strands the batch', async () => {
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });

    checkCompleteness.mockResolvedValue({ level: 'error', complete: false, retryable: true });

    await io.fetch(appendReq('сделай отчёт по выставке'));
    await state.storage.put('debounceExpiresAt', Date.now() - 1);
    await io.alarm();

    expect(handleMessage).not.toHaveBeenCalled();
    const retry = editMessage.mock.calls.filter(c => String(c[3]).includes('Судья запуска недоступен'));
    expect(retry.length).toBe(1);
    // The batch keeps a live timer and an alarm — a retry is actually scheduled.
    expect(await state.storage.get('debounceExpiresAt')).toBeGreaterThan(Date.now());
    expect(state._dump().alarm).not.toBeNull();
    expect(await state.storage.get('gateErrAttempts')).toBe(1);

    // Second failure: one more retry (attempt 2 of 3), still scheduled.
    await state.storage.put('debounceExpiresAt', Date.now() - 1);
    await io.alarm();
    expect(await state.storage.get('gateErrAttempts')).toBe(2);
    expect(await state.storage.get('debounceExpiresAt')).toBeGreaterThan(Date.now());

    // Third failure: budget spent — stop retrying, hand over to the explicit
    // «нажми ▶️» text (and its button). The way out always exists.
    await state.storage.put('debounceExpiresAt', Date.now() - 1);
    await io.alarm();
    expect(handleMessage).not.toHaveBeenCalled();
    const plain = editMessage.mock.calls.filter(c => String(c[3]).includes('Не хватает контекста'));
    expect(plain.length).toBe(1);
    expect(await state.storage.get('debounceExpiresAt')).toBeUndefined();
    expect(await state.storage.get('gateErrAttempts')).toBeUndefined();
  });

  it('a judge recovery inside the retry budget still auto-dispatches', async () => {
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });

    checkCompleteness.mockResolvedValueOnce({ level: 'error', complete: false, retryable: true });
    await io.fetch(appendReq('сделай отчёт по выставке'));
    await state.storage.put('debounceExpiresAt', Date.now() - 1);
    await io.alarm();
    expect(handleMessage).not.toHaveBeenCalled();

    checkCompleteness.mockResolvedValue({ level: 'clear', complete: true });
    await state.storage.put('debounceExpiresAt', Date.now() - 1);
    await io.alarm(); await drain();
    expect(handleMessage).toHaveBeenCalledTimes(1);
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

  it('a ▶️ tap while media is still downloading is acknowledged and then launches by itself', async () => {
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });

    await state.storage.put('buf', [
      { text: 'вот файл', msg: { chat: { id: 42 }, message_id: 6 }, },
      { text: undefined, msg: { chat: { id: 42 }, message_id: 7, mediaJob: 'job-1' },
        mediaPending: true, mediaOwner: 'alice', mediaFirstSeenAt: Date.now() },
    ]);

    // The tap must NOT read as a dead button: acknowledge that the batch was
    // taken and remember the intent for when the last attachment lands.
    const res = await io.fetch(flushReq());
    expect(await res.json()).toMatchObject({ preparing: true, queued: true });
    expect(await state.storage.get('launchWhenReady')).toBe(true);
    expect(handleMessage).not.toHaveBeenCalled();
    expect(sendMessageWithKeyboard).toHaveBeenCalledWith(
      't', 42, expect.stringContaining('Задачу забрал'), expect.anything(), expect.anything());
    // "Задачу забрал" = the tap landed: the launch button must not linger under it.
    expect(JSON.stringify(sendMessageWithKeyboard.mock.calls.at(-1)[3])).not.toContain('intake_run');

    // Attachment resolves → the queued tap fires the run, no second tap needed.
    await io.fetch(new Request('https://intake/media-result', {
      method: 'POST',
      body: JSON.stringify({
        id: 'job-1', messageId: 7, username: 'alice',
        fileRef: { id: 'job-1', storage: 'r2' }, transcript: 'сделай отчёт',
      }),
    }));
    await drain();
    expect(handleMessage).toHaveBeenCalledTimes(1);
  });

  it('a media job stuck past MEDIA_DEADLINE_MS is dropped so the chat can launch again', async () => {
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });

    await state.storage.put('buf', [{
      text: undefined, msg: { chat: { id: 42 }, message_id: 7, mediaJob: 'job-stuck' },
      mediaPending: true, mediaOwner: 'alice', mediaFirstSeenAt: Date.now() - 20 * 60_000,
    }]);

    // Without the deadline this item sat mediaPending forever (its MediaJob DO
    // lost the alarm), so every tap answered «ещё грузится» and nothing ran.
    await io.alarm();

    const buf = (await state.storage.get('buf')) || [];
    expect(buf.some(i => i.mediaPending)).toBe(false);
    expect(await state.storage.get('media-failed:job-stuck')).toBeTruthy();
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

// ── Issue #305: a queued ▶️ tap turns the button into its own undo ────────────
// Owner 29.09.2026: «кнопка "передать агенту" должна пропасть после нажатия …
// оставить хвост: "отменить передачу агенту". так что кнопка в любом случае будет
// и кейс более четкий».
describe('queued launch has an «↩️ Отменить передачу агента» tail (#305)', () => {
  async function queueWhileBusy() {
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });
    await io.fetch(appendReq('start the task'));
    await io.fetch(flushReq()); await drain();
    await io.fetch(appendReq('supplement during run'));
    const tap = await (await io.fetch(flushReq())).json();
    expect(tap).toMatchObject({ busy: true, queued: true });
    return { state, io };
  }

  it('a queued ▶️ tap swaps the button for ↩️ and says the batch is waiting', async () => {
    const { state } = await queueWhileBusy();
    expect(await state.storage.get('launchQueued')).toBe(true);

    const [token, chatId, text, keyboard] = sendMessageWithKeyboard.mock.calls.at(-1);
    expect(token).toBe('t'); expect(chatId).toBe(42);
    expect(text).toContain('уйдёт агенту сразу после текущей задачи');
    const kb = JSON.stringify(keyboard);
    expect(kb).toContain('intake_cancel');
    expect(kb).not.toContain('intake_run');
  });

  it('a receipt/alarm re-render while queued keeps ↩️, never paints ▶️ back', async () => {
    const { state, io } = await queueWhileBusy();
    await receipt(io); // the held receipt renders from the alarm
    const [, , , text, opts] = editMessage.mock.calls.at(-1);
    expect(text).toContain('уйдёт агенту сразу после текущей задачи');
    const kb = JSON.stringify(opts);
    expect(kb).toContain('intake_cancel');
    expect(kb).not.toContain('intake_run');
    expect(await state.storage.get('launchQueued')).toBe(true);
  });

  it('↩️ cancel clears the queue, restores ▶️, and the batch does NOT auto-launch', async () => {
    const { state, io } = await queueWhileBusy();
    const res = await (await io.fetch(new Request('https://intake/cancel', { method: 'POST' }))).json();
    // stopLaunchCancelled rides along: «↩️ Отменить» must also cover a pending
    // «стоп + запуск» choice, and the user has to be told the task stays stopped.
    expect(res).toEqual({ cancelled: true, stopLaunchCancelled: false });
    expect(await state.storage.get('launchQueued')).toBeUndefined();
    expect(await state.storage.get('launchAfterRelease')).toBeUndefined();

    // Collector re-rendered with ▶️ back (held receipt — busy is still true).
    const [, , , text, opts] = editMessage.mock.calls.at(-1);
    expect(text).toContain('Получил ещё');
    expect(JSON.stringify(opts)).toContain('intake_run');
    expect(JSON.stringify(opts)).not.toContain('intake_cancel');

    await io.fetch(runFinishedReq('req-default')); await drain();
    expect(handleMessage).toHaveBeenCalledTimes(1); // no phantom launch after cancel
  });

  it('cancel with nothing queued reports cancelled:false and renders nothing', async () => {
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });
    const res = await (await io.fetch(new Request('https://intake/cancel', { method: 'POST' }))).json();
    expect(res).toEqual({ cancelled: false, stopLaunchCancelled: false });
    expect(editMessage).not.toHaveBeenCalled();
    expect(sendMessageWithKeyboard).not.toHaveBeenCalled();
  });

  it('run-finished consumes the queue flag along with the launch', async () => {
    const { state, io } = await queueWhileBusy();
    await io.fetch(runFinishedReq('req-default')); await drain();
    expect(handleMessage).toHaveBeenCalledTimes(2);
    expect(await state.storage.get('launchQueued')).toBeUndefined();
    expect(await state.storage.get('launchAfterRelease')).toBeUndefined();
  });

  it('a queued tap on a still-downloading batch wears ↩️ too', async () => {
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });
    await state.storage.put('buf', [
      { text: 'вот файл', msg: { chat: { id: 42 }, message_id: 6 } },
      { text: undefined, msg: { chat: { id: 42 }, message_id: 7, mediaJob: 'job-1' },
        mediaPending: true, mediaOwner: 'alice', mediaFirstSeenAt: Date.now() },
    ]);
    const res = await io.fetch(flushReq());
    expect(await res.json()).toMatchObject({ preparing: true, queued: true });
    expect(await state.storage.get('launchQueued')).toBe(true);
    const kb = JSON.stringify(sendMessageWithKeyboard.mock.calls.at(-1)[3]);
    expect(kb).toContain('intake_cancel');
    expect(kb).not.toContain('intake_run');
  });
});

// #1856 — ⛔ Стоп reaches the buffer itself (/stop), not only the agent.
describe('IntakeBuffer — /stop holds the queue (#1856)', () => {
  const stopReq = () => new Request('https://intake/stop', { method: 'POST', body: JSON.stringify({ replyTo: 7 }) });

  it('a stop landing while the expiry judge is in flight wins: no dispatch, collector «Остановлено»', async () => {
    const state = makeState(); const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });
    await io.fetch(appendReq('сделай отчёт'));
    await state.storage.delete('receiptDue');
    await state.storage.put('debounceExpiresAt', Date.now() - 1);
    let answer;
    checkCompleteness.mockImplementationOnce(() => new Promise(r => { answer = r; }));
    const alarm = io.alarm();
    await drain();
    await io.fetch(stopReq());
    answer({ level: 'clear', complete: true });
    await alarm; await drain();
    expect(handleMessage).not.toHaveBeenCalled();
    expect(await state.storage.get('stopped')).toBeTruthy();
    const texts = [...sendMessageWithKeyboard.mock.calls.map(c => c[2]), ...editMessage.mock.calls.map(c => c[3])];
    expect(texts.some(t => /Остановлено\. 1 сообщений ждут/.test(t))).toBe(true);
  });

  it('while busy: keeps the busy safety poll, drops launchAfterRelease; run-finished releases without launching', async () => {
    const state = makeState(); const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });
    await io.fetch(appendReq('first'));
    await io.fetch(flushReq()); await drain();
    await io.fetch(appendReq('held'));
    await state.storage.put('launchAfterRelease', true);
    const res = await (await io.fetch(stopReq())).json();
    expect(res).toMatchObject({ stopped: true, held: 1, busy: true, hadIntent: true });
    expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
    expect(await state.storage.get('launchAfterRelease')).toBeUndefined();
    await io.fetch(runFinishedReq('req-default')); await drain();
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(await state.storage.get('busy')).toBeUndefined();
    // ▶️ lifts the hold.
    await io.fetch(flushReq()); await drain();
    expect(handleMessage).toHaveBeenCalledTimes(2);
    expect(handleMessage.mock.calls[1][0].text).toBe('held');
  });
});
