import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock every module the DO pulls in so the state machine runs in isolation.
const handleMessage = vi.fn();
const checkCompleteness = vi.fn();
const isTaskRunning = vi.fn();
const sendMessage = vi.fn();

vi.mock('../src/handlers/message.js', () => ({ handleMessage: (...a) => handleMessage(...a) }));
vi.mock('../src/lib/agent-client.js', () => ({
  checkCompleteness: (...a) => checkCompleteness(...a),
  isTaskRunning: (...a) => isTaskRunning(...a),
}));
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
  // Default: a real run started (mirrors agent /run → 202 { taskId }).
  handleMessage.mockResolvedValue({ dispatched: true, username: 'u' });
});

describe('IntakeBuffer — ШАГ 1.3 busy-hold (poll-driven)', () => {
  it('holds messages for the REAL run duration (polling), then flushes them as ONE dispatch', async () => {
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't', AGENT_URL: 'x', AGENT_SECRET: 's' });

    // First message arrives while idle → armed for debounce, not dispatched yet.
    await io.fetch(appendReq('start the task'));
    expect(handleMessage).not.toHaveBeenCalled();

    // Debounce fires → dispatch. handleMessage returns fast (202 enqueue), the run
    // itself is still "live" as far as the agent is concerned.
    await io.alarm();
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(handleMessage.mock.calls[0][0].text).toBe('start the task');
    expect(await state.storage.get('busy')).toBe(true);
    expect(await state.storage.get('pollUser')).toBe('u');

    // Messages sent WHILE the session runs must be buffered, not dispatched.
    await io.fetch(appendReq('actually also do X'));
    await io.fetch(appendReq('and Y'));
    expect(handleMessage).toHaveBeenCalledTimes(1);

    // Poll #1: agent reports the session is still live → keep holding.
    isTaskRunning.mockResolvedValueOnce({ running: true });
    await io.alarm();
    expect(await state.storage.get('busy')).toBe(true);
    expect(handleMessage).toHaveBeenCalledTimes(1);

    // Poll #2: session finished → release the hold and arm the post-run debounce.
    isTaskRunning.mockResolvedValueOnce({ running: false });
    await io.alarm();
    expect(await state.storage.get('busy')).toBeUndefined();
    expect(state._dump().alarm).toBeGreaterThan(0);

    // Post-run flush → the two held messages dispatch as ONE coalesced text.
    await io.alarm();
    expect(handleMessage).toHaveBeenCalledTimes(2);
    expect(handleMessage.mock.calls[1][0].text).toBe('actually also do X\nand Y');
  });

  it('does NOT release prematurely while the run is still enqueued (start-up grace)', async () => {
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't', AGENT_URL: 'x', AGENT_SECRET: 's' });

    await io.fetch(appendReq('go'));
    await io.alarm(); // dispatch → busy
    expect(await state.storage.get('busy')).toBe(true);

    // Poll returns not-running, but we've never seen it start and we're inside the
    // grace window → the enqueued proc just hasn't spawned yet. Keep holding.
    isTaskRunning.mockResolvedValue({ running: false });
    await io.alarm();
    expect(await state.storage.get('busy')).toBe(true);
    expect(await state.storage.get('seenRunning')).toBeUndefined();

    // It appears in the registry → mark seen.
    isTaskRunning.mockResolvedValue({ running: true });
    await io.alarm();
    expect(await state.storage.get('seenRunning')).toBe(true);

    // Now a not-running poll DOES mean finished → release.
    isTaskRunning.mockResolvedValue({ running: false });
    await io.alarm();
    expect(await state.storage.get('busy')).toBeUndefined();
  });

  it('does not busy-hold when no run actually started (session picker / inline handling)', async () => {
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't', AGENT_URL: 'x', AGENT_SECRET: 's' });
    handleMessage.mockResolvedValueOnce({ dispatched: false }); // disambiguation, no run

    await io.fetch(appendReq('ambiguous'));
    await io.alarm();

    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(await state.storage.get('busy')).toBeUndefined();
    expect(isTaskRunning).not.toHaveBeenCalled(); // nothing to poll for
  });

  it('recovers a buffer trapped by a dead run once BUSY_MAX elapses', async () => {
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't', AGENT_URL: 'x', AGENT_SECRET: 's' });

    // Simulate an isolate that died mid-run: busy set long ago, messages waiting.
    await state.storage.put('busy', true);
    await state.storage.put('busySince', 1); // effectively "ages ago"
    await state.storage.put('pollUser', 'u');
    await state.storage.put('buf', [{ text: 'hello', msg: { chat: { id: 42 }, text: 'hello' } }]);

    await io.alarm(); // BUSY_MAX exceeded → release without even polling
    expect(await state.storage.get('busy')).toBeUndefined();
    expect(isTaskRunning).not.toHaveBeenCalled();

    // Post-run flush dispatches the stranded message.
    await io.alarm();
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(handleMessage.mock.calls[0][0].text).toBe('hello');
  });

  it('keeps holding when the agent is unreachable (isTaskRunning fails closed)', async () => {
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't', AGENT_URL: 'x', AGENT_SECRET: 's' });

    await io.fetch(appendReq('go'));
    await io.alarm(); // dispatch → busy
    await state.storage.put('seenRunning', true); // run was observed live

    // Client fails closed → running:true → hold persists (bounded by BUSY_MAX).
    isTaskRunning.mockResolvedValue({ running: true });
    await io.alarm();
    expect(await state.storage.get('busy')).toBe(true);
  });
});
