import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock every module the DO pulls in so the state machine runs in isolation.
const handleMessage = vi.fn();
const checkCompleteness = vi.fn();
const sendMessage = vi.fn();

vi.mock('../src/handlers/message.js', () => ({ handleMessage: (...a) => handleMessage(...a) }));
vi.mock('../src/lib/agent-client.js', () => ({ checkCompleteness: (...a) => checkCompleteness(...a) }));
vi.mock('../src/lib/telegram.js', () => ({ sendMessage: (...a) => sendMessage(...a) }));

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

function appendReq(text) {
  return new Request('https://intake/append', {
    method: 'POST',
    body: JSON.stringify({ text, msg: { chat: { id: 42 }, text } }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  checkCompleteness.mockResolvedValue({ complete: true });
});

describe('IntakeBuffer — ШАГ 1.3 busy-hold', () => {
  it('holds messages that arrive during a run and flushes them as ONE coalesced dispatch', async () => {
    const state = makeState();
    const env = { BOT_TOKEN: 't' };
    const io = new IntakeBuffer(state, env);

    // First message arrives while idle → armed for debounce, not dispatched yet.
    await io.fetch(appendReq('start the task'));
    expect(handleMessage).not.toHaveBeenCalled();

    // Control the run: handleMessage stays pending while we pile on more messages.
    let release;
    handleMessage.mockReturnValueOnce(new Promise(r => { release = r; }));

    const runPromise = io.alarm();               // debounce fires → dispatch begins
    // Dynamic import() inside alarm() settles on a macrotask, so drain real timers too.
    for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(handleMessage.mock.calls[0][0].text).toBe('start the task');

    // Messages sent WHILE the session runs must be buffered, not dispatched.
    await io.fetch(appendReq('actually also do X'));
    await io.fetch(appendReq('and Y'));
    expect(handleMessage).toHaveBeenCalledTimes(1); // still just the one run

    release();                                    // session finishes
    await runPromise;

    // On completion the held messages are armed for a short post-run debounce.
    expect(state._dump().alarm).toBeGreaterThan(0);
    expect(await state.storage.get('busy')).toBeUndefined();

    // Fire the post-run flush → the two held messages dispatch as ONE coalesced text.
    await io.alarm();
    expect(handleMessage).toHaveBeenCalledTimes(2);
    expect(handleMessage.mock.calls[1][0].text).toBe('actually also do X\nand Y');
  });

  it('recovers a buffer trapped by a dead run once BUSY_MAX elapses', async () => {
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });

    // Simulate an isolate that died mid-run: busy set long ago, messages waiting.
    await state.storage.put('busy', true);
    await state.storage.put('busySince', 1); // effectively "ages ago"
    await state.storage.put('buf', [{ text: 'hello', msg: { chat: { id: 42 }, text: 'hello' } }]);

    await io.alarm();

    // Hold released and the stranded message dispatched.
    expect(await state.storage.get('busy')).toBeUndefined();
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(handleMessage.mock.calls[0][0].text).toBe('hello');
  });
});
