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
    expect(handleMessage.mock.calls[0][2]).toEqual({ mode: 'deep', onPrepared: expect.any(Function) });
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
    expect(handleMessage.mock.calls[0][2]).toEqual({ mode: 'deep', onPrepared: expect.any(Function) }); // force word also launches deep
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

describe('accepted task lifecycle', () => {
  it('keeps busy after 202, holds follow-ups, and releases only after terminal status', async () => {
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't', AGENT_URL: 'https://agent.test', AGENT_SECRET: 'test' });
    handleMessage.mockResolvedValueOnce({ taskId: 'task-1' });
    await io.fetch(appendReq('first'));
    await io.fetch(flushReq());
    expect(await state.storage.get('busy')).toBe(true);
    await io.fetch(appendReq('follow-up'));
    expect(handleMessage).toHaveBeenCalledTimes(1);
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = vi.fn().mockResolvedValueOnce(Response.json({ state: 'accepted' }))
        .mockResolvedValueOnce(Response.json({ state: 'unknown' }))
        .mockResolvedValueOnce(Response.json({ state: 'settled' }));
      await io.alarm();
      expect(await state.storage.get('busy')).toBe(true);
      await io.alarm();
      expect(await state.storage.get('busy')).toBe(true);
      await io.alarm();
      expect(await state.storage.get('busy')).toBeUndefined();
      expect(await state.storage.get('activeRun')).toBeUndefined();
      expect((await state.storage.get('buf'))[0].text).toBe('follow-up');
      expect(handleMessage).toHaveBeenCalledTimes(1);
      expect(sendMessageWithKeyboard).toHaveBeenCalledTimes(2);
    } finally { globalThis.fetch = originalFetch; }
  });

  it('passes every media message in order with the trace ID', async () => {
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });
    const messages = [
      { chat: { id: 42 }, message_id: 1, photo: [{ file_id: 'p1' }] },
      { chat: { id: 42 }, message_id: 2, document: { file_id: 'd1' } },
      { chat: { id: 42 }, message_id: 3, text: 'compare these' },
    ];
    for (const msg of messages) await io.fetch(new Request('https://intake/append', { method: 'POST', body: JSON.stringify({ text: msg.text || '', msg }) }));
    await io.fetch(flushReq());
    const sent = handleMessage.mock.calls[0][0];
    expect(sent.intakeMessages).toEqual(messages);
    expect(sent.traceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('restores a rejected batch and offers explicit retry', async () => {
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });
    handleMessage.mockRejectedValueOnce(new Error('download failed'));
    await io.fetch(appendReq('keep this'));
    await io.fetch(flushReq());
    expect((await state.storage.get('buf'))[0].text).toBe('keep this');
    expect(await state.storage.get('busy')).toBeUndefined();
    expect(sendMessageWithKeyboard).toHaveBeenCalledTimes(2);
  });
});

describe('ambiguous delivery reconciliation', () => {
  it('retains the packet across timeout, holds follow-ups, and releases only on terminal status', async () => {
    const state = makeState();
    const env = { BOT_TOKEN: 't', AGENT_SECRET: 'test' };
    const io = new IntakeBuffer(state, env);
    handleMessage.mockRejectedValueOnce(Object.assign(new Error('timeout'), {
      delivery: 'unknown', taskId: 'u-intake-trace-1', agentUrl: 'https://agent.test',
    }));
    await io.fetch(appendReq('original'));
    await io.fetch(flushReq());
    expect((await state.storage.get('dispatchPacket')).messages[0].msg.text).toBe('original');
    expect(await state.storage.get('busy')).toBe(true);
    await io.fetch(appendReq('follow-up'));
    await io.fetch(flushReq());
    expect(handleMessage).toHaveBeenCalledTimes(1);
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ state: 'accepted' })));
      await new IntakeBuffer(state, env).alarm();
      expect(await state.storage.get('busy')).toBe(true);
      globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ state: 'settled' })));
      await new IntakeBuffer(state, env).alarm();
      expect(await state.storage.get('busy')).toBeUndefined();
      expect(await state.storage.get('dispatchPacket')).toBeUndefined();
      expect((await state.storage.get('buf'))[0].msg.text).toBe('follow-up');
      expect(handleMessage).toHaveBeenCalledTimes(1);
    } finally { globalThis.fetch = originalFetch; }
  });
  it('does not discard an unacknowledged packet after an isolate crash', async () => {
    const state = makeState();
    await state.storage.put('dispatchPacket', { traceId: 't', messages: [{ msg: { text: 'original' } }] });
    await state.storage.put('busy', true);
    await state.storage.put('busySince', 1);
    await new IntakeBuffer(state, { BOT_TOKEN: 't' }).alarm();
    expect(await state.storage.get('busy')).toBe(true);
    expect(await state.storage.get('dispatchPacket')).toBeDefined();
    expect(handleMessage).not.toHaveBeenCalled();
  });
});

describe('prepared request recovery', () => {
  it('persists exact request before POST and retries on the same agent only after capability confirmation', async () => {
    const state = makeState();
    const io = new IntakeBuffer(state, { AGENT_SECRET: 'test' });
    const body = { username: 'u', traceId: 'trace', task: 'original', files: [{ fileBase64: 'a'.repeat(35000) }] };
    await io._prepareRun({ taskId: 'u-intake-trace', agentUrl: 'https://agent.test', body }, 'trace', 42);
    expect((await state.storage.get('activeRun')).chunks).toBeGreaterThan(1);
    const mock = vi.fn().mockResolvedValueOnce(Response.json({ state: 'unknown', retrySafe: true }))
      .mockResolvedValueOnce(Response.json({ taskId: 'u-intake-trace' }, { status: 202 }));
    vi.stubGlobal('fetch', mock);
    try {
      await io.alarm();
      expect(mock.mock.calls[1][0]).toBe('https://agent.test/run');
      expect(JSON.parse(mock.mock.calls[1][1].body)).toEqual(body);
      expect((await state.storage.get('activeRun')).retries).toBe(1);
    } finally { vi.unstubAllGlobals(); }
  });

  it('caps retries and does not replay against an older agent', async () => {
    const state = makeState();
    const io = new IntakeBuffer(state, { AGENT_SECRET: 'test' });
    await io._prepareRun({ taskId: 'u-intake-t', agentUrl: 'https://agent.test', body: { traceId: 't' } }, 't', 42);
    const mock = vi.fn().mockResolvedValue(Response.json({ state: 'unknown' }));
    vi.stubGlobal('fetch', mock);
    try {
      await io.alarm();
      expect(mock).toHaveBeenCalledTimes(1);
      const active = await state.storage.get('activeRun');
      active.retries = 3;
      await state.storage.put('activeRun', active);
      mock.mockResolvedValue(Response.json({ state: 'unknown', retrySafe: true }));
      await io.alarm();
      expect(mock).toHaveBeenCalledTimes(2);
      expect(await state.storage.get('activeRun')).toBeDefined();
    } finally { vi.unstubAllGlobals(); }
  });
});

it('restores a packet interrupted before HTTP preparation exactly once', async () => {
  const state = makeState();
  const io = new IntakeBuffer(state, {});
  await state.storage.put('busy', true);
  await state.storage.put('dispatchPacket', { preparedProtocol: 1, messages: [{ text: 'first', msg: { chat: { id: 42 }, text: 'first' } }] });
  await state.storage.put('buf', [{ text: 'second', msg: { chat: { id: 42 }, text: 'second' } }]);
  await io.alarm();
  await io.alarm();
  expect((await state.storage.get('buf')).map(item => item.text)).toEqual(['first', 'second']);
  expect(await state.storage.get('dispatchPacket')).toBeUndefined();
  expect(await state.storage.get('busy')).toBeUndefined();
});
