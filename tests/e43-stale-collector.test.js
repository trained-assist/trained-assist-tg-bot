import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { handleMessage, checkCompleteness, route, request, stopTargets, send, edit, publishRoutingDegradation, enqueue, drain, loadDelivery } = vi.hoisted(() => ({
  handleMessage: vi.fn(), checkCompleteness: vi.fn(), route: vi.fn(), request: vi.fn(), send: vi.fn(), edit: vi.fn(),
  stopTargets: vi.fn(),
  publishRoutingDegradation: vi.fn(),
  enqueue: vi.fn(), drain: vi.fn(), loadDelivery: vi.fn(),
}));

vi.mock('../src/sandbox-tg/delivery-owner.js', () => ({
  TgDeliveryOwnerClient: class {
    enqueue(record) { return enqueue(record); }
    drain() { return drain(); }
    load(deliveryId) { return loadDelivery(deliveryId); }
  },
}));

vi.mock('../src/handlers/message.js', () => ({ handleMessage }));
vi.mock('../src/lib/agent-client.js', () => ({ checkCompleteness }));
vi.mock('../src/lib/control-plane-execution.js', () => ({
  controlPlaneClient: () => ({ config: { profileId: 'test-profile', botUsername: 'test-bot' }, route, request, stopTargets }),
  publishRoutingDegradation,
}));
vi.mock('../src/lib/telegram.js', () => ({
  sendMessage: send, sendMessageWithKeyboard: send, editMessage: edit,
}));

import { IntakeBuffer } from '../src/intake-buffer.js';

const T0 = new Date('2026-10-13T10:00:00Z');

function fixture() {
  const values = new Map();
  let alarm;
  const storage = {
    async get(key) { return structuredClone(values.get(key)); },
    async put(key, value) { values.set(key, structuredClone(value)); },
    async delete(key) { values.delete(key); },
    async list({ prefix = '' } = {}) { return new Map([...values].filter(([key]) => key.startsWith(prefix))); },
    async setAlarm(value) { alarm = value; },
    async getAlarm() { return alarm; },
    async deleteAlarm() { alarm = undefined; },
    async transaction(callback) { return callback(storage); },
  };
  const env = {
    EXECUTION_BACKEND: 'control-plane', TG_SANDBOX_BOT_TOKEN: 'test-bot-token',
    TG_SANDBOX_BOT_USERNAME: 'test-bot', AGENT_URL: 'https://legacy.invalid',
  };
  const owner = new IntakeBuffer({ storage }, env);
  owner.env.SESSIONS = { get: async key => key === '42' ? JSON.stringify({ username: 'test-profile' }) : null, put: async () => {} };
  return { storage, env, owner };
}

const rpc = (path, body) => new Request(`https://intake${path}`, body === undefined ? undefined
  : { method: 'POST', body: JSON.stringify(body) });

const msg = (message_id, text = 'm') => ({ text, msg: { chat: { id: 42 }, message_id, text } });

async function append(owner, messageId, text) {
  const res = await owner.fetch(rpc('/append', msg(messageId, text)));
  return res.json();
}

async function advanceAndAlarm(owner, from, ms) {
  vi.setSystemTime(new Date(from.getTime() + ms));
  await owner.alarm();
}

const callbacksOf = call => (call[4]?.reply_markup?.inline_keyboard || []).flat().map(button => button.callback_data);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  vi.clearAllMocks();
  route.mockResolvedValue({});
  stopTargets.mockImplementation(async input => ({ snapshotId: 'snapshot-test', profileId: 'test-profile',
    conversationId: input.conversationId, tasks: [{ requestId: 'scoped-request', userTaskId: 'ut-test',
    profileId: 'test-profile', receiptId: 'receipt:test' }], unresolved: false, stopConfirmed: true }));
  publishRoutingDegradation.mockResolvedValue(undefined);
  request.mockResolvedValue({ value: { taskStore: { id: 'ut-test', profile_id: 'test-profile', status: 'done', generation: 1 } } });
  enqueue.mockImplementation(async record => ({ record: { ...record, status: 'pending' }, duplicate: false }));
  drain.mockResolvedValue(1);
  loadDelivery.mockImplementation(async deliveryId => ({ deliveryId, status: 'sent' }));
  send.mockResolvedValue({ ok: true, result: { message_id: 99 } });
  edit.mockResolvedValue({ ok: true });
  handleMessage.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('E4.3 stale collector button', () => {
  it('S1: idle second message re-edits the collector to the live revision; old revision tap is refused', async () => {
    const { owner, storage } = fixture();

    await append(owner, 1, 'first');
    expect(await storage.get('draftRevision')).toBe(1);
    expect(await storage.get('debounceExpiresAt')).not.toBeNull();

    await advanceAndAlarm(owner, T0, 2000);
    expect(send).toHaveBeenCalledTimes(1);
    const collectorId = await storage.get('collectorMsgId');
    expect(collectorId).toBe(99);
    expect(await storage.get('collectorDraftRevision')).toBe(1);

    await append(owner, 2, 'second');
    expect(await storage.get('draftRevision')).toBe(2);
    expect(await storage.get('debounceExpiresAt')).not.toBeNull();

    // E4.3 regression guard: the collector must be re-edited to the live
    // revision synchronously on intake — not only after the receipt alarm.
    expect(await storage.get('collectorDraftRevision')).toBe(2);
    expect(callbacksOf(edit.mock.calls.at(-1))).toContain('intake_ready');

    await advanceAndAlarm(owner, new Date(T0.getTime() + 2000), 2000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await storage.get('collectorDraftRevision')).toBe(2);

    const fresh = await owner.fetch(rpc('/flush', { messageId: collectorId, callbackData: 'ws|answer|2', username: 'test-profile' }));
    expect(fresh.status).toBe(200);

    const stale = await owner.fetch(rpc('/flush', { messageId: collectorId, callbackData: 'ws|answer|1', username: 'test-profile' }));
    expect(stale.status).toBe(409);
    expect((await stale.json()).reasonCode).toBe('callback_no_longer_owned');
  });

  it('S2: tap → dispatch → release → new message shows a fresh-revision collector that launches', async () => {
    const { owner, storage } = fixture();

    await append(owner, 1, 'first');
    await advanceAndAlarm(owner, T0, 2000);
    const collectorId = await storage.get('collectorMsgId');
    expect(await storage.get('collectorDraftRevision')).toBe(1);

    const tap = await owner.fetch(rpc('/flush', { messageId: collectorId, callbackData: 'ws|answer|1', username: 'test-profile' }));
    expect(tap.status).toBe(200);
    expect(await storage.get('busy')).toBe(true);

    await owner.fetch(rpc('/run-finished', {}));
    expect(await storage.get('busy')).toBeUndefined();

    await append(owner, 2, 'second');
    expect(await storage.get('draftRevision')).toBe(2);
    await advanceAndAlarm(owner, new Date(T0.getTime() + 2000), 2000);

    expect(await storage.get('collectorDraftRevision')).toBe(2);
    expect(callbacksOf(edit.mock.calls.at(-1))).toContain('intake_ready');

    const tap2 = await owner.fetch(rpc('/flush', { messageId: collectorId, callbackData: 'ws|answer|2', username: 'test-profile' }));
    expect(tap2.status).toBe(200);
  });

  it('S3: tap → dispatch → held message during run → release shows fresh-revision collector that launches', async () => {
    const { owner, storage } = fixture();

    await append(owner, 1, 'first');
    await advanceAndAlarm(owner, T0, 2000);
    const collectorId = await storage.get('collectorMsgId');

    const tap = await owner.fetch(rpc('/flush', { messageId: collectorId, callbackData: 'ws|answer|1', username: 'test-profile' }));
    expect(tap.status).toBe(200);
    expect(await storage.get('busy')).toBe(true);

    await append(owner, 2, 'second');
    expect((await storage.get('buf')).map(i => i.msg.message_id)).toEqual([2]);

    await owner.fetch(rpc('/run-finished', {}));
    expect(await storage.get('busy')).toBeUndefined();
    expect(await storage.get('draftRevision')).toBe(2);
    expect(await storage.get('collectorDraftRevision')).toBe(2);
    expect(await storage.get('collectorMsgId')).toBe(99);
    expect(callbacksOf(edit.mock.calls.at(-1))).toContain('intake_ready');

    const tap2 = await owner.fetch(rpc('/flush', { messageId: collectorId, callbackData: 'ws|answer|2', username: 'test-profile' }));
    expect(tap2.status).toBe(200);
  });

  it('S4: quiet timer waits for explicit dispatch → held message → release shows fresh-revision collector that launches', async () => {
    const { owner, storage } = fixture();

    await append(owner, 1, 'first');
    await advanceAndAlarm(owner, T0, 2000);
    expect(await storage.get('collectorDraftRevision')).toBe(1);

    await advanceAndAlarm(owner, new Date(T0.getTime() + 2000), 3 * 60 * 1000);
    expect(await storage.get('busy')).not.toBe(true);
    await owner._dispatch();
    expect(await storage.get('busy')).toBe(true);
    expect(await storage.get('debounceExpiresAt')).toBeUndefined();

    await append(owner, 2, 'second');
    expect(await storage.get('draftRevision')).toBe(2);

    await owner.fetch(rpc('/run-finished', {}));
    expect(await storage.get('busy')).toBeUndefined();
    expect(await storage.get('collectorDraftRevision')).toBe(2);
    expect(await storage.get('collectorMsgId')).toBe(99);
    expect(callbacksOf(edit.mock.calls.at(-1))).toContain('intake_ready');

    const tap2 = await owner.fetch(rpc('/flush', { messageId: 99, callbackData: 'ws|answer|2', username: 'test-profile' }));
    expect(tap2.status).toBe(200);
  });

  it('S5: message arriving right after dispatch (claim sent, collectorMsgId cleared) still gets a fresh collector', async () => {
    const { owner, storage } = fixture();

    await append(owner, 1, 'first');
    await advanceAndAlarm(owner, T0, 2000);
    const collectorId = await storage.get('collectorMsgId');
    const acceptedReceipt = { requestId: 'scoped-request', profileId: 'test-profile', userTaskId: 'ut-test',
      durable: true, providerAcceptedAt: 1700000000000 };
    handleMessage.mockImplementationOnce(async (message, _env, options) => {
      await owner.fetch(rpc('/snapshot', { body: { username: 'test-profile', requestId: acceptedReceipt.requestId,
        controlPlaneEnvelope: { requestId: acceptedReceipt.requestId, profileId: acceptedReceipt.profileId,
          conversationRef: 'tg-42-ssaved' } }, items: message.intakeItems }));
      await owner.fetch(rpc('/cp-acceptance', { requestId: acceptedReceipt.requestId, receipt: acceptedReceipt }));
      options.onRunAccepted({ taskId: acceptedReceipt.userTaskId, userTaskId: acceptedReceipt.userTaskId,
        requestId: acceptedReceipt.requestId, durable: true, controlPlane: true });
    });

    const tap = await owner.fetch(rpc('/flush', { messageId: collectorId, callbackData: 'ws|answer|1', username: 'test-profile' }));
    expect(tap.status).toBe(200);
    await owner.alarm(); // Background checkpoint owns the collector transition now.
    expect(await storage.get('collectorMsgId')).toBeUndefined();

    await owner.fetch(rpc('/run-finished', {}));
    await append(owner, 2, 'second');
    await advanceAndAlarm(owner, new Date(T0.getTime() + 2000), 2000);

    expect(await storage.get('draftRevision')).toBe(2);
    expect(await storage.get('collectorDraftRevision')).toBe(2);
    expect(await storage.get('collectorMsgId')).toBe(99);

    const tap2 = await owner.fetch(rpc('/flush', { messageId: 99, callbackData: 'ws|answer|2', username: 'test-profile' }));
    expect(tap2.status).toBe(200);
  });
});
