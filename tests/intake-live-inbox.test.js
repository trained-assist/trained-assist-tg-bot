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
  agentBases: env => [...new Set([env.AGENT_URL, env.AGENT_RU_URL].filter(Boolean))],
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
  // Real handleMessage fires onRunAccepted after the agent acks (message.js
  // handleText) — that ack is what makes _dispatch KEEP busy for the run's
  // lifetime (epic #1527 PR1 / F1). Tests that need a custom flow override it.
  handleMessage.mockImplementation(async (msg, env, opts) => {
    opts?.onRunAccepted?.({ requestId: 'req-default', durable: true, taskId: 'task-default' });
  });
});


// Live inbox (owner 2026-09-29): the running model pulls messages the user sent
// AFTER its run started (agent MCP get_new_messages → /internal/held-messages →
// DO /held), and the ids it took in come back as `consumed` on run-finished so
// the collector doesn't re-offer them as a new task.
let nextId = 500;
const msgReq = text => new Request('https://intake/append', {
  method: 'POST',
  body: JSON.stringify({ text, msg: { chat: { id: 42 }, text, message_id: nextId++, date: 1790640000 } }),
});
const heldReq = requestId => new Request(`https://intake/held${requestId ? `?requestId=${requestId}` : ''}`);
const finishedReq = body => new Request('https://intake/run-finished', { method: 'POST', body: JSON.stringify(body) });

async function busyIo() {
  const state = makeState();
  const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });
  await io.fetch(msgReq('start the task'));
  await io.fetch(flushReq());
  await drain();
  expect(await state.storage.get('busy')).toBe(true);
  return { state, io };
}

describe('IntakeBuffer — live inbox (/held + consumed)', () => {
  it('outside a run /held is empty — nothing is "new after start"', async () => {
    const state = makeState();
    const io = new IntakeBuffer(state, { BOT_TOKEN: 't' });
    await io.fetch(msgReq('idle message'));
    expect(await (await io.fetch(heldReq())).json()).toEqual({ busy: false, items: [] });
  });

  it('during a run /held returns exactly the messages sent after the start, launch input excluded', async () => {
    const { io } = await busyIo();
    await io.fetch(msgReq('пароль: hunter2'));
    await io.fetch(msgReq('и ещё сделай отчёт'));
    const body = await (await io.fetch(heldReq('req-default'))).json();
    expect(body.busy).toBe(true);
    expect(body.items.map(i => i.text)).toEqual(['пароль: hunter2', 'и ещё сделай отчёт']);
    expect(body.items[0]).toMatchObject({ kind: 'text', ready: true, date: 1790640000, files: [] });
    expect(Number.isSafeInteger(body.items[0].message_id)).toBe(true);
  });

  it("another run's requestId cannot read this run's held input", async () => {
    const { io } = await busyIo();
    await io.fetch(msgReq('secret'));
    expect(await (await io.fetch(heldReq('someone-else'))).json()).toEqual({ busy: true, mismatch: true, items: [] });
  });

  it('run-finished drops consumed messages; unread ones stay for the collector', async () => {
    const { state, io } = await busyIo();
    await io.fetch(msgReq('used by the model'));
    await io.fetch(msgReq('not read'));
    const [used, unread] = (await (await io.fetch(heldReq('req-default'))).json()).items;
    const res = await io.fetch(finishedReq({ requestId: 'req-default', consumed: [used.message_id] }));
    expect(await res.json()).toMatchObject({ released: true, dropped: 1 });
    expect(((await state.storage.get('buf')) || []).map(i => i.msg.message_id)).toEqual([unread.message_id]);
    // The collector is re-offered for the unread one only.
    expect(sendMessageWithKeyboard.mock.calls.at(-1)?.[2] || editMessage.mock.calls.at(-1)?.[3]).toMatch(/1 сообщен/);
  });

  it('everything consumed → no collector left behind', async () => {
    const { state, io } = await busyIo();
    await io.fetch(msgReq('the only one'));
    const [only] = (await (await io.fetch(heldReq('req-default'))).json()).items;
    sendMessageWithKeyboard.mockClear();
    await io.fetch(finishedReq({ requestId: 'req-default', consumed: [only.message_id] }));
    expect((await state.storage.get('buf')) || []).toEqual([]);
    expect(sendMessageWithKeyboard).not.toHaveBeenCalled();
  });

  it('a mismatched run-finished never drops anything (direction of error: keep the message)', async () => {
    const { state, io } = await busyIo();
    await io.fetch(msgReq('keep me'));
    const [m] = (await (await io.fetch(heldReq('req-default'))).json()).items;
    await io.fetch(finishedReq({ requestId: 'foreign', consumed: [m.message_id] }));
    expect(((await state.storage.get('buf')) || []).length).toBe(1);
    expect(await state.storage.get('busy')).toBe(true);
  });

  it('garbage consumed values are ignored', async () => {
    const { state, io } = await busyIo();
    await io.fetch(msgReq('keep me'));
    await io.fetch(finishedReq({ requestId: 'req-default', consumed: ['x', null, 1.5] }));
    expect(((await state.storage.get('buf')) || []).length).toBe(1);
  });
});
