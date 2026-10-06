import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  controlPlaneClient: () => ({ config: { profileId: 'test-profile' }, route, request, stopTargets }),
  publishRoutingDegradation,
}));
vi.mock('../src/lib/telegram.js', () => ({
  sendMessage: send, sendMessageWithKeyboard: send, editMessage: edit,
}));

import { IntakeBuffer } from '../src/intake-buffer.js';

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
  return { storage, env, owner };
}

const items = [{ text: 'first', msg: { message_id: 1, chat: { id: 42 }, text: 'first' } }];
const receipt = { userTaskId: 'ut-test', requestId: 'scoped-request', profileId: 'test-profile', durable: true, providerAcceptedAt: 1700000000000 };
const rpc = (path, body) => new Request(`https://intake${path}`, body === undefined ? undefined
  : { method: 'POST', body: JSON.stringify(body) });

async function snapshot(owner, inputReceipt = receipt, inputItems = items) {
  return owner.fetch(rpc('/snapshot', {
    body: { username: 'test-profile', requestId: inputReceipt.requestId,
      controlPlaneEnvelope: { requestId: inputReceipt.requestId, profileId: inputReceipt.profileId, conversationRef: 'tg-42-ssaved' } },
    items: inputItems,
  }));
}

async function accept(owner, inputReceipt = receipt) {
  await snapshot(owner, inputReceipt);
  return owner.fetch(rpc('/cp-acceptance', { requestId: inputReceipt.requestId, receipt: inputReceipt }));
}

beforeEach(() => {
  vi.clearAllMocks();
  route.mockResolvedValue({});
  stopTargets.mockImplementation(async input => ({ snapshotId: 'snapshot-test', profileId: 'test-profile',
    conversationId: input.conversationId, tasks: [{ requestId: receipt.requestId, userTaskId: receipt.userTaskId,
      profileId: receipt.profileId, receiptId: 'receipt:test' }], unresolved: false, stopConfirmed: true }));
  publishRoutingDegradation.mockResolvedValue(undefined);
  request.mockResolvedValue({ value: { taskStore: { id: receipt.userTaskId, profile_id: receipt.profileId, status: 'done', generation: 1 } } });
  enqueue.mockImplementation(async record => ({ record: { ...record, status: 'pending' }, duplicate: false }));
  drain.mockResolvedValue(1);
  loadDelivery.mockImplementation(async deliveryId => ({ deliveryId, status: 'sent' }));
  send.mockResolvedValue({ ok: true, result: { message_id: 99 } });
  edit.mockResolvedValue({ ok: true });
  handleMessage.mockResolvedValue(undefined);
});

describe('existing collector control-plane ownership', () => {
  it.each(['/stop', '/cp-stop-targets', '/stop-launch', '/callback-confirmation', '/supplement'])
  ('explicit false refuses %s without changing durable stop intent or input', async path => {
    const { owner, storage } = fixture();
    owner.env.TG_SLICE_STOP_ENABLED = 'false';
    await storage.put('buf', items);
    await storage.put('cpStopWindow', { pending: true, intentId: 'preserved-intent' });
    await storage.put('stopLaunch', { mode: 'supp', at: 1700000000000 });
    const before = await storage.list();
    const response = await owner._fetch(rpc(path, {}));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'control_plane_stop_disabled' });
    expect(await storage.list()).toEqual(before);
    expect(stopTargets).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it.each([false, true])('disabled pending stop still delivers terminal with routingKnown=%s after cold restart', async routingKnown => {
    const { owner, storage, env } = fixture();
    await accept(owner);
    env.TG_SLICE_STOP_ENABLED = 'false';
    const accepted = await storage.get(`cp-acceptance:${receipt.requestId}`);
    if (routingKnown) await storage.put(`cp-acceptance:${receipt.requestId}`, { ...accepted,
      routingOutcome: { known: true, publicationComplete: true, degraded: false } });
    const pending = { pending: true, intentId: 'preserved-intent', username: 'test-profile', chatId: 42, threadId: null };
    const restart = { mode: 'supp', route: { sessionId: 'same-session' }, at: 1700000000000 };
    await storage.put('cpStopWindow', pending);
    await storage.put('stopLaunch', restart);
    await storage.put('stopped', 1700000000000);
    await storage.put('buf', items);
    const restarted = new IntakeBuffer({ storage }, env);
    await restarted.alarm();
    expect(request).toHaveBeenCalledWith('POST', '/status', { body: { taskId: receipt.userTaskId } });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0]).toMatchObject({ deliveryId: `terminal:${receipt.userTaskId}:g1`, userTaskId: receipt.userTaskId });
    expect(await storage.get('busy')).toBeUndefined();
    expect(await storage.get('cpStopWindow')).toEqual(pending);
    expect(await storage.get('stopLaunch')).toEqual(restart);
    expect(await storage.get('stopped')).toBe(1700000000000);
    expect(await storage.get('buf')).toEqual(items);
    expect(stopTargets).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
    expect(handleMessage).not.toHaveBeenCalled();
    expect(await storage.getAlarm()).toBeGreaterThan(Date.now());
    await restarted.alarm();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(await storage.get('cpStopWindow')).toEqual(pending);
    expect(await storage.get('stopLaunch')).toEqual(restart);
  });

  it('disabled stop consumption cannot delete a retained launch intent', async () => {
    const { owner, storage } = fixture();
    owner.env.TG_SLICE_STOP_ENABLED = 'false';
    await storage.put('stopLaunch', { mode: 'supp' });
    const before = await storage.list();
    expect(await owner._consumeStopLaunch()).toBe(false);
    await expect(owner._driveControlPlaneStop({})).rejects.toMatchObject({ code: 'CONTROL_PLANE_STOP_DISABLED' });
    expect(await storage.list()).toEqual(before);
    expect(stopTargets).not.toHaveBeenCalled();
  });

  async function stopFixture(threadId = null) {
    const value = fixture();
    const session = JSON.stringify({ username: 'test-profile' });
    value.owner.env.SESSIONS = { get: async key => key === '42' ? session : null, put: async () => {} };
    const sourceItems = threadId === null ? items : [{ ...items[0], msg: {
      ...items[0].msg, is_topic_message: true, message_thread_id: threadId,
    } }];
    await snapshot(value.owner, receipt, sourceItems);
    await value.owner.fetch(rpc('/cp-acceptance', { requestId: receipt.requestId, receipt }));
    await value.storage.put(`cp-acceptance:${receipt.requestId}`, { receipt, terminal: false,
      routingOutcome: { known: true, publicationComplete: true, degraded: false } });
    await value.storage.put('cpScope', { chatId: 42, threadId, profileId: receipt.profileId });
    await value.owner.fetch(rpc('/stop', { username: 'test-profile', chatId: 42, threadId }));
    return { ...value, source: { username: 'test-profile', chatId: 42, threadId } };
  }

  it('calls the CP stop endpoint with generic conversation identity and durable admissions', async () => {
    const { owner, source } = await stopFixture();
    const response = await owner.fetch(rpc('/cp-stop-targets', { ...source, userTaskId: 'caller-invented' }));
    const result = await response.json();
    expect(result).toMatchObject({ profileId: receipt.profileId, unresolved: false, stopConfirmed: true,
      tasks: [{ requestId: receipt.requestId, userTaskId: receipt.userTaskId, profileId: receipt.profileId, receiptId: 'receipt:test' }] });
    expect(stopTargets).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'tg-42-ssaved', admissionBarrierComplete: true, admissionRequestIds: [receipt.requestId], restart: false,
    }));
    expect(route).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('maps one Telegram stop to separate CP windows when accepted receipts use distinct conversations', async () => {
    const { owner, storage, env } = fixture();
    owner.env.SESSIONS = env.SESSIONS = { get: async key => key === '42' ? JSON.stringify({ username: 'test-profile' }) : null, put: async () => {} };
    const second = { ...receipt, requestId: `tgcp-${'e'.repeat(64)}`, userTaskId: 'ut-second' };
    await accept(owner, receipt);
    const secondItems = [{ text: 'second', msg: { message_id: 2, chat: { id: 42 }, text: 'second' } }];
    await owner.fetch(rpc('/snapshot', { body: { username: 'test-profile', requestId: second.requestId,
      controlPlaneEnvelope: { requestId: second.requestId, profileId: second.profileId, conversationRef: 'tg-42-sother' } }, items: secondItems }));
    await owner.fetch(rpc('/cp-acceptance', { requestId: second.requestId, receipt: second }));
    await storage.put('cpScope', { chatId: 42, threadId: null, profileId: receipt.profileId });
    const source = { username: 'test-profile', chatId: 42, threadId: null };
    await owner.fetch(rpc('/stop', source));
    const response = await owner.fetch(rpc('/cp-stop-targets', source));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.stopConfirmed).toBe(true);
    expect(stopTargets).toHaveBeenCalledTimes(2);
    expect(stopTargets.mock.calls.map(([input]) => [input.conversationId, input.admissionRequestIds])
      .sort(([left], [right]) => left.localeCompare(right)))
      .toEqual([['tg-42-sother', [second.requestId]], ['tg-42-ssaved', [receipt.requestId]]]);
    expect(stopTargets.mock.calls.every(([input]) => !('chatId' in input) && !('username' in input))).toBe(true);
  });

  it.each([{ username: 'foreign' }, { chatId: 43 }, { threadId: 18 }, { chatId: '42' }])('refuses foreign stop scope %j', async changed => {
    const { owner, source } = await stopFixture(17);
    expect((await owner.fetch(rpc('/cp-stop-targets', { ...source, ...changed }))).status).toBe(409);
  });

  it.each(['inflight', 'unknown-launch', 'busy-no-receipt', 'missing-snapshot', 'wrong-receipt-profile'])('cannot produce empty stop proof for %s', async kind => {
    const { owner, storage, source } = await stopFixture();
    if (kind === 'inflight') owner.cpDispatches = 1;
    if (kind === 'unknown-launch') await storage.put('cpUnresolvedLaunches', ['unknown-batch']);
    if (kind === 'busy-no-receipt') await storage.delete('cpBusyRequests');
    if (kind === 'missing-snapshot') await storage.delete(`input:${receipt.requestId}`);
    if (kind === 'wrong-receipt-profile') await storage.put(`cp-acceptance:${receipt.requestId}`, { receipt: { ...receipt, profileId: 'foreign' } });
    const response = await (await owner.fetch(rpc('/cp-stop-targets', source))).json();
    expect(response.unresolved).toBe(kind === 'busy-no-receipt' ? false : true);
    const before = await storage.list();
    expect((await owner.fetch(rpc('/stop', source))).status).toBe(200);
    expect((await storage.get('cpStopWindow')).pending).toBe(true);
    expect(await storage.get(`cp-acceptance:${receipt.requestId}`)).toEqual(before.get(`cp-acceptance:${receipt.requestId}`));
  });

  it('persists an unresolved stop barrier and prevents cold recovery from routing after stop', async () => {
    const { owner, storage, env, source } = await stopFixture();
    env.SESSIONS = owner.env.SESSIONS;
    const launchKey = JSON.stringify([2]);
    const pendingItems = [{ text: 'unconfirmed', msg: { chat: { id: 42 }, message_id: 2, text: 'unconfirmed' } }];
    await storage.put('cpUnresolvedLaunches', [launchKey]);
    await storage.put(`cp-launch:${launchKey}`, { msg: { ...pendingItems[0].msg, intakeItems: pendingItems },
      initialMsgId: null, profileId: receipt.profileId, botUsername: undefined });
    expect((await owner.fetch(rpc('/stop', source))).status).toBe(200);
    const restarted = new IntakeBuffer({ storage }, env);
    await restarted.alarm();
    expect((await storage.get('cpStopWindow')).pending).toBe(true);
    expect(await storage.get(`cp-launch:${launchKey}`)).toBeDefined();
    expect(await storage.get('busy')).toBe(true);
    expect(handleMessage).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
  });

  it.each(['false', 'true'])('matches busy stop buttons to the explicit runtime gate %s', async stopEnabled => {
    const { owner, storage } = fixture();
    owner.env.TG_SLICE_STOP_ENABLED = stopEnabled;
    await storage.put('busy', true);
    await storage.put('buf', items);
    await owner._showCollector(42, 1, 1);
    const buttons = send.mock.calls.at(-1)[3].flat().map(button => button.callback_data.split('|')[0]);
    expect(buttons).toEqual(expect.arrayContaining(['intake_run', 'intake_parallel', 'input_draft']));
    expect(buttons.includes('intake_stopsupp')).toBe(stopEnabled === 'true');
    expect(buttons.includes('intake_stopnew')).toBe(stopEnabled === 'true');
  });

  it('preserves legacy busy stop buttons despite the control-plane gate', async () => {
    const { storage, env } = fixture();
    const owner = new IntakeBuffer({ storage }, { ...env, EXECUTION_BACKEND: 'legacy', TG_SLICE_STOP_ENABLED: 'false' });
    await storage.put('busy', true);
    await storage.put('buf', items);
    await owner._showCollector(42, 1, 1);
    const buttons = send.mock.calls.at(-1)[3].flat().map(button => button.callback_data);
    expect(buttons).toEqual(expect.arrayContaining(['intake_stopsupp', 'intake_stopnew']));
  });

  it('shows unconfirmed stop even with held input rather than claiming the task stopped', async () => {
    const { owner, storage, source } = await stopFixture();
    await owner.fetch(rpc('/stop', source));
    await storage.put('buf', [{ text: 'held', msg: { chat: { id: 42 }, message_id: 2, text: 'held' } }]);
    await owner._showCollector(42, 1, 2, null, '⛔ Остановлено');
    expect(send.mock.calls.at(-1)[2]).toBe('⏳ Остановка текущей задачи ещё не подтверждена. 1 сообщений сохранены; новый запуск не выполняется.');
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('retains stopped task identities across terminal polling and restart; pending stop blocks new input launch', async () => {
    const { owner, storage, env, source } = await stopFixture();
    env.SESSIONS = owner.env.SESSIONS;
    expect((await owner.fetch(rpc('/stop', source))).status).toBe(200);
    expect((await storage.get('cpStopWindow')).pending).toBe(true);
    expect(await owner._pollRunFinishedIfIdle(0)).toBe(true);
    expect(route).not.toHaveBeenCalled();
    expect(await storage.get('cpBusyRequests')).toBeUndefined();
    const restarted = new IntakeBuffer({ storage }, env);
    const targets = await (await restarted.fetch(rpc('/cp-stop-targets', source))).json();
    expect(targets.tasks).toEqual([{ requestId: receipt.requestId, userTaskId: receipt.userTaskId,
      profileId: receipt.profileId, receiptId: 'receipt:test' }]);
    expect(targets.unresolved).toBe(false);
    await restarted.fetch(rpc('/append', { text: 'запускай', msg: { chat: { id: 42 }, message_id: 2, text: 'запускай' }, telegramUpdateId: 102, flush: true }));
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(await storage.get('stopped')).toBeUndefined();
    expect((await storage.get('buf')) || []).toEqual([]);
    expect((await storage.get('cpStopWindow')).pending).toBe(false);
  });

  it('retries the same immutable CP stop window after an unknown admission barrier and updates the collector on confirmation', async () => {
    const { owner, storage, source } = await stopFixture();
    owner.cpDispatches = 1;
    const unresolved = await (await owner.fetch(rpc('/cp-stop-targets', source))).json();
    expect(unresolved).toMatchObject({ unresolved: true, stopConfirmed: false });
    expect(stopTargets).not.toHaveBeenCalled();
    owner.cpDispatches = 0;
    stopTargets.mockResolvedValueOnce({ snapshotId: null, profileId: receipt.profileId,
      conversationId: 'tg-42-ssaved', tasks: [], unresolved: true, stopConfirmed: false, reason: 'native_stop_unknown' });
    const firstPoll = await (await owner.fetch(rpc('/cp-stop-targets', source))).json();
    expect(firstPoll.unresolved).toBe(true);
    const firstWindowId = stopTargets.mock.calls.at(-1)[0].windowId;
    await owner.alarm();
    expect(stopTargets.mock.calls.at(-1)[0].windowId).toBe(firstWindowId);
    expect((await storage.get('cpStopWindow')).pending).toBe(false);
    expect(send).toHaveBeenCalled();
  });

  it('freezes a complete ordered burst despite concurrent out-of-order appends and duplicate updates', async () => {
    const { owner, storage } = fixture();
    await Promise.all([3, 1, 2, 1].map(messageId => owner.fetch(rpc('/append', {
      text: `part-${messageId}`, msg: { chat: { id: 42 }, message_id: messageId, text: `part-${messageId}` },
      telegramUpdateId: 100 + messageId,
    }))));
    expect(await storage.get('buf')).toHaveLength(3);
    handleMessage.mockImplementationOnce(async (message, env, options) => {
      expect(message.intakeItems.map(item => item.msg.message_id)).toEqual([1, 2, 3]);
      expect(message.intakeItems.map(item => item.text)).toEqual(['part-1', 'part-2', 'part-3']);
      await snapshot(owner, receipt, message.intakeItems);
      await owner.fetch(rpc('/cp-acceptance', { requestId: receipt.requestId, receipt }));
      options.onRunAccepted({ taskId: receipt.userTaskId, userTaskId: receipt.userTaskId,
        requestId: receipt.requestId, durable: true, controlPlane: true });
    });
    await owner._dispatch();
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect((await owner._readSnapshot(receipt.requestId)).items.map(item => item.msg.message_id)).toEqual([1, 2, 3]);
  });

  it('holds busy add-input after terminal completion until explicit choice, without a legacy judge', async () => {
    const { owner, storage, env } = fixture();
    await accept(owner);
    await owner.fetch(rpc('/append', { text: 'later', msg: { chat: { id: 42 }, message_id: 2, text: 'later' }, telegramUpdateId: 102 }));
    expect((await storage.get('buf'))[0].heldWhileBusy).toBe(true);
    expect(await owner._pollRunFinishedIfIdle(0)).toBe(true);
    const restarted = new IntakeBuffer({ storage }, env);
    await storage.put('debounceExpiresAt', Date.now() - 1);
    await storage.put('autoPolicy', 'quiet-3m-v1');
    await restarted.alarm();
    expect(handleMessage).not.toHaveBeenCalled();
    expect(checkCompleteness).not.toHaveBeenCalled();
    expect((await storage.get('buf')).map(item => item.msg.message_id)).toEqual([2]);
    expect(await storage.get('busy')).toBeUndefined();
  });

  it('honors one explicit busy queue choice only after authoritative completion of the original task', async () => {
    const { owner, storage } = fixture();
    owner.env.SESSIONS = { get: async key => key === '42' ? JSON.stringify({ username: 'test-profile' }) : null, put: async () => {} };
    await accept(owner);
    for (const messageId of [2, 3]) await owner.fetch(rpc('/append', {
      text: `later-${messageId}`, msg: { chat: { id: 42 }, message_id: messageId, text: `later-${messageId}` }, telegramUpdateId: 100 + messageId,
    }));
    await owner._showCollector(42, 2, 3);
    request.mockResolvedValueOnce({ value: { taskStore: { id: receipt.userTaskId, profile_id: receipt.profileId, status: 'running' } } });
    const queued = await owner.fetch(rpc('/flush', { sourceMessageId: await storage.get('collectorMsgId'), callbackData: 'intake_run', username: 'test-profile' }));
    expect((await queued.json()).queued).toBe(true);
    expect(handleMessage).not.toHaveBeenCalled();
    const second = { ...receipt, userTaskId: 'ut-second', requestId: 'scoped-second' };
    handleMessage.mockImplementationOnce(async (message, env, options) => {
      expect(message.intakeItems.map(item => item.msg.message_id)).toEqual([2, 3]);
      await snapshot(owner, second, message.intakeItems);
      await owner.fetch(rpc('/cp-acceptance', { requestId: second.requestId, receipt: second }));
      options.onRunAccepted({ taskId: second.userTaskId, userTaskId: second.userTaskId,
        requestId: second.requestId, durable: true, controlPlane: true });
    });
    expect(await owner._pollRunFinishedIfIdle(0)).toBe(true);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(await storage.get('busy')).toBe(true);
    expect(await storage.get('cpBusyRequests')).toEqual([second.requestId]);
    expect(await storage.get('launchAfterRelease')).toBeUndefined();
  });

  it.each([true, false])('publishes cached flat routing degradation with issued=%s to the frozen destination', async issued => {
    const { owner } = fixture();
    const topicItems = [{ ...items[0], msg: { ...items[0].msg, message_thread_id: 17, is_topic_message: true } }];
    await snapshot(owner, receipt, topicItems);
    await owner.fetch(rpc('/cp-acceptance', { requestId: receipt.requestId, receipt }));
    const routed = { degraded: true, continuation: { issued } };
    route.mockResolvedValue(routed);
    expect(await owner._pollRunFinishedIfIdle(0)).toBe(true);
    expect(publishRoutingDegradation).toHaveBeenCalledWith(owner.env, receipt, routed,
      { chatId: 42, threadId: 17 }, `tg-42-ssaved-b${receipt.requestId.slice(-24)}`);
  });

  it('keeps ownership if degradation publication fails and retries the same cached route', async () => {
    const { owner, storage } = fixture();
    await accept(owner);
    route.mockResolvedValue({ degraded: true, continuation: { issued: false } });
    publishRoutingDegradation.mockRejectedValueOnce(new Error('owner unavailable'));
    expect(await owner._pollRunFinishedIfIdle(0)).toBe(false);
    expect(await storage.get('busy')).toBe(true);
    expect(request).not.toHaveBeenCalled();
    expect(await owner._pollRunFinishedIfIdle(0)).toBe(true);
    expect(route.mock.calls).toEqual([[receipt.userTaskId], [receipt.userTaskId]]);
    expect(publishRoutingDegradation).toHaveBeenCalledTimes(2);
  });

  it('uses a neutral CP launch label without changing legacy labels or actions', async () => {
    const { owner, storage } = fixture();
    await storage.put('buf', items);
    await owner._showCollector(42, 1, 1);
    expect(send.mock.calls[0][3]).toEqual([[{ text: '▶️ Запустить', callback_data: 'intake_run' },
      { text: '📋 Посмотреть input', callback_data: 'input_draft' }]]);
    send.mockClear();
    const legacy = new IntakeBuffer({ storage }, { BOT_TOKEN: 'legacy-token' });
    await storage.delete('collectorMsgId');
    await legacy._showCollector(42, 1, 1);
    expect(send.mock.calls[0][3]).toEqual([[{ text: '▶️ Запустить агента', callback_data: 'intake_run' },
      { text: '📋 Посмотреть input', callback_data: 'input_draft' }]]);
  });

  it('launches a durably appended force word while refusing source-less external flush', async () => {
    const { owner, storage } = fixture();
    await owner.fetch(rpc('/append', { text: 'first', msg: items[0].msg, telegramUpdateId: 100 }));
    handleMessage.mockImplementationOnce(async (message, env, options) => {
      expect(message.intakeItems.map(item => item.msg.message_id)).toEqual([1, 2]);
      expect(message.intakeItems.map(item => item.text)).toEqual(['first', 'запускай']);
      await snapshot(owner, receipt, message.intakeItems);
      await owner.fetch(rpc('/cp-acceptance', { requestId: receipt.requestId, receipt }));
      options.onRunAccepted({ taskId: receipt.userTaskId, userTaskId: receipt.userTaskId,
        requestId: receipt.requestId, durable: true, controlPlane: true });
    });
    const launch = await owner.fetch(rpc('/append', {
      text: 'запускай', msg: { message_id: 2, chat: { id: 42 }, text: 'запускай' }, telegramUpdateId: 101, flush: true,
    }));
    expect(launch.status).toBe(200);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    const before = await storage.get('cpBusyRequests');
    expect((await owner.fetch(rpc('/flush', {}))).status).toBe(409);
    expect(await storage.get('cpBusyRequests')).toEqual(before);
    expect(handleMessage).toHaveBeenCalledTimes(1);
  });

  it('normalizes only CP bot environment', () => {
    const { owner } = fixture();
    expect(owner.env.BOT_TOKEN).toBe('test-bot-token');
    expect(owner.env.BOT_USERNAME).toBe('test-bot');
    const legacy = new IntakeBuffer(owner.state, { BOT_TOKEN: 'legacy-token' });
    expect(legacy.env.BOT_TOKEN).toBe('legacy-token');
  });

  it('returns an absent receipt without issuing HTTP', async () => {
    const { owner } = fixture();
    expect(await (await owner.fetch(rpc('/cp-acceptance?requestId=missing'))).json()).toEqual({ receipt: null });
    expect(request).not.toHaveBeenCalled();
  });

  it('persists identical scoped acceptance and reconciles after reconstruction', async () => {
    const { owner, storage, env } = fixture();
    expect((await accept(owner)).status).toBe(200);
    expect((await accept(owner)).status).toBe(200);
    expect(await storage.get('cpBusyRequests')).toEqual([receipt.requestId]);
    const restarted = new IntakeBuffer({ storage }, env);
    expect(await (await restarted.fetch(rpc(`/cp-acceptance?requestId=${receipt.requestId}`))).json()).toEqual({ receipt });
    expect(route).not.toHaveBeenCalled();
  });

  it.each([
    { ...receipt, userTaskId: 'different-task' },
    { ...receipt, requestId: 'different-request' },
    { ...receipt, profileId: 'different-profile' },
    { ...receipt, durable: false },
  ])('refuses conflicting acceptance %j', async conflicting => {
    const { owner } = fixture();
    await accept(owner);
    const response = await owner.fetch(rpc('/cp-acceptance', { requestId: receipt.requestId, receipt: conflicting }));
    expect(response.status).toBe(409);
  });

  it('requires frozen envelope and configured profile', async () => {
    const { owner } = fixture();
    expect((await owner.fetch(rpc('/cp-acceptance', { requestId: receipt.requestId, receipt }))).status).toBe(409);
    expect((await accept(owner, { ...receipt, profileId: 'foreign-profile' })).status).toBe(409);
  });

  it.each(['running', 'awaiting', 'unknown', undefined])('holds nonterminal %s beyond legacy lifetime', async status => {
    const { owner, storage } = fixture();
    await accept(owner);
    await storage.put('busySince', Date.now() - 90 * 60_000);
    await storage.put('launching', items);
    request.mockResolvedValue({ value: { taskStore: { id: receipt.userTaskId, profile_id: receipt.profileId, status } } });
    await owner.alarm();
    expect(await storage.get('busy')).toBe(true);
    expect(await storage.get('launching')).toEqual(items);
    expect(await storage.getAlarm()).toBeGreaterThan(Date.now());
    expect(route).toHaveBeenCalledWith(receipt.userTaskId);
    expect(request).toHaveBeenCalledWith('POST', '/status', { body: { taskId: receipt.userTaskId } });
  });

  it.each(['done', 'failed', 'cancelled'])('releases only matching authoritative terminal %s', async status => {
    const { owner, storage } = fixture();
    await accept(owner);
    request.mockResolvedValue({ value: { taskStore: { id: receipt.userTaskId, profile_id: receipt.profileId, status, generation: 1 } } });
    expect(await owner._pollRunFinishedIfIdle(0)).toBe(true);
    expect(await storage.get('busy')).toBeUndefined();
    expect((await storage.get(`cp-acceptance:${receipt.requestId}`)).terminal).toBe(true);
    await accept(owner);
    expect(await storage.get('busy')).toBeUndefined();
  });

  it.each([
    ['done', 'actual answer', 'actual answer'],
    ['done', { answer: 'native answer' }, 'native answer'],
    ['done', '   ', 'Готово. Текст результата отсутствует.'],
    ['failed', { answer: 'not a successful answer' }, 'Ошибка исполнителя.'],
    ['cancelled', null, 'Отменено.'],
  ])('uses the controller terminal identity and payload for %s with result %j', async (status, result, text) => {
    const { owner, storage } = fixture();
    const sourceItems = [{ ...items[0], msg: { ...items[0].msg,
      is_topic_message: true, message_thread_id: 7 } }];
    await snapshot(owner, receipt, sourceItems);
    await owner.fetch(rpc('/cp-acceptance', { requestId: receipt.requestId, receipt }));
    request.mockResolvedValue({ value: { taskStore: {
      id: receipt.userTaskId, profile_id: receipt.profileId, status, generation: 2, result,
    } } });
    enqueue.mockImplementation(async record => {
      expect(await storage.get('busy')).toBe(true);
      expect((await storage.get(`cp-acceptance:${receipt.requestId}`)).terminal).not.toBe(true);
      return { record: { ...record, status: 'pending' }, duplicate: false };
    });
    expect(await owner._pollRunFinishedIfIdle(0)).toBe(true);
    const deliveryId = `terminal:${receipt.userTaskId}:g2`;
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith({ deliveryId,
      taskAcceptedAt: receipt.providerAcceptedAt,
      conversationId: `tg-42-ssaved-b${receipt.requestId.slice(-24)}`,
      userTaskId: receipt.userTaskId, destination: { chatId: 42, threadId: 7 },
      requestId: deliveryId, type: 'message', text });
    expect(drain).toHaveBeenCalledTimes(1);
    expect(loadDelivery).toHaveBeenCalledTimes(1);
    expect(loadDelivery).toHaveBeenCalledWith(deliveryId);
    expect(send).not.toHaveBeenCalled();
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it.each(['enqueue', 'drain'])('keeps terminal ownership after %s ACK loss and retries the identical owner record after restart', async boundary => {
    const { owner, storage, env } = fixture();
    await accept(owner);
    (boundary === 'enqueue' ? enqueue : drain).mockRejectedValueOnce(new Error('ACK lost'));
    expect(await owner._pollRunFinishedIfIdle(0)).toBe(false);
    expect(await storage.get('busy')).toBe(true);
    expect((await storage.get(`cp-acceptance:${receipt.requestId}`)).terminal).not.toBe(true);
    const first = structuredClone(enqueue.mock.calls[0][0]);
    const restarted = new IntakeBuffer({ storage }, env);
    expect(await restarted._pollRunFinishedIfIdle(0)).toBe(true);
    expect(enqueue.mock.calls[1][0]).toEqual(first);
    expect(route).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it('continues owner drain on busy alarms when another queued delivery was drained first', async () => {
    const { owner, storage, env } = fixture();
    await accept(owner);
    loadDelivery.mockResolvedValueOnce({ deliveryId: `terminal:${receipt.userTaskId}:g1`, status: 'pending' });
    await owner.alarm();
    expect(await storage.get('busy')).toBe(true);
    expect(await storage.getAlarm()).toBeGreaterThan(Date.now());
    const restarted = new IntakeBuffer({ storage }, env);
    await restarted.alarm();
    expect(await storage.get('busy')).toBeUndefined();
    expect(enqueue.mock.calls[1][0]).toEqual(enqueue.mock.calls[0][0]);
    expect(drain).toHaveBeenCalledTimes(2);
    expect(send).not.toHaveBeenCalled();
  });

  it.each(['unknown', 'sending', 'retrying', 'quarantined'])('does not release terminal ownership or bypass the owner on %s delivery', async status => {
    const { owner, storage } = fixture();
    await accept(owner);
    enqueue.mockImplementation(async record => ({ record: { ...record, status }, duplicate: true }));
    loadDelivery.mockImplementation(async deliveryId => ({ deliveryId, status }));
    expect(await owner._pollRunFinishedIfIdle(0)).toBe(false);
    expect(await storage.get('busy')).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(handleMessage).not.toHaveBeenCalled();
    if (status === 'quarantined') expect(drain).not.toHaveBeenCalled();
  });

  it.each([null, '1700000000000', 0])('rejects unproven provider acceptance timestamp %j before enqueue', async providerAcceptedAt => {
    const { owner, storage } = fixture();
    await accept(owner, { ...receipt, providerAcceptedAt });
    expect(await owner._pollRunFinishedIfIdle(0)).toBe(false);
    expect(await storage.get('busy')).toBe(true);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it.each([undefined, 0, '1'])('rejects unproven terminal generation %j before enqueue', async generation => {
    const { owner, storage } = fixture();
    await accept(owner);
    request.mockResolvedValue({ value: { taskStore: {
      id: receipt.userTaskId, profile_id: receipt.profileId, status: 'done', generation,
    } } });
    expect(await owner._pollRunFinishedIfIdle(0)).toBe(false);
    expect(await storage.get('busy')).toBe(true);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it.each([
    { id: 'foreign-task', profile_id: receipt.profileId, status: 'done' },
    { id: receipt.userTaskId, profile_id: 'foreign-profile', status: 'done' },
    null,
  ])('does not release on foreign or missing task %j', async taskStore => {
    const { owner, storage } = fixture();
    await accept(owner);
    request.mockResolvedValue({ value: { taskStore } });
    expect(await owner._pollRunFinishedIfIdle(0)).toBe(false);
    expect(await storage.get('busy')).toBe(true);
  });

  it('holds timeout and unaccepted launch despite legacy completion push', async () => {
    const { owner, storage } = fixture();
    await storage.put('busy', true);
    await storage.put('launching', items);
    await storage.put('busySince', Date.now() - 90 * 60_000);
    await owner.fetch(rpc('/run-finished', {}));
    await owner.alarm();
    expect(await storage.get('busy')).toBe(true);
    expect(await storage.get('launching')).toEqual(items);
    await accept(owner);
    request.mockRejectedValue(new Error('timeout'));
    expect(await owner._pollRunFinishedIfIdle(0)).toBe(false);
    expect(await storage.get('busy')).toBe(true);
  });

  it('retains terminal task ownership after route read failure until cached degradation is published', async () => {
    const { owner, storage, env } = fixture();
    await accept(owner);
    route.mockRejectedValueOnce(new Error('ack lost'));
    expect(await owner._pollRunFinishedIfIdle(0)).toBe(false);
    expect(await storage.get('busy')).toBe(true);
    expect((await storage.get(`cp-acceptance:${receipt.requestId}`)).routingOutcome).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
    const restarted = new IntakeBuffer({ storage }, env);
    route.mockResolvedValue({ degraded: true, continuation: { issued: true } });
    expect(await restarted._pollRunFinishedIfIdle(0)).toBe(true);
    expect(await storage.get('busy')).toBeUndefined();
    expect((await storage.get(`cp-acceptance:${receipt.requestId}`)).routingOutcome).toEqual({
      known: true, publicationComplete: true, degraded: true, continuationIssued: true,
    });
    expect(route.mock.calls).toEqual([[receipt.userTaskId], [receipt.userTaskId]]);
    expect(publishRoutingDegradation).toHaveBeenCalledTimes(1);
    expect(handleMessage).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('retains persisted routing outcome across restart without repeating notice enqueue', async () => {
    const { owner, storage, env } = fixture();
    await accept(owner);
    route.mockResolvedValue({ degraded: true, continuation: { issued: false } });
    request.mockResolvedValueOnce({ value: { taskStore: { id: receipt.userTaskId, profile_id: receipt.profileId, status: 'running' } } });
    expect(await owner._pollRunFinishedIfIdle(0)).toBe(false);
    expect((await storage.get(`cp-acceptance:${receipt.requestId}`)).routingOutcome.publicationComplete).toBe(true);
    route.mockRejectedValue(new Error('later route transport outage'));
    const restarted = new IntakeBuffer({ storage }, env);
    expect(await restarted._pollRunFinishedIfIdle(0)).toBe(true);
    expect(route).toHaveBeenCalledTimes(1);
    expect(publishRoutingDegradation).toHaveBeenCalledTimes(1);
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('does not release while another admission is unresolved or in flight', async () => {
    const { owner, storage } = fixture();
    await accept(owner);
    await storage.put('cpUnresolvedLaunches', ['second-batch']);
    expect(await owner._pollRunFinishedIfIdle(0)).toBe(false);
    await storage.delete('cpUnresolvedLaunches');
    owner.cpDispatches = 1;
    expect(await owner._pollRunFinishedIfIdle(0)).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it('rechecks concurrent new acceptance before releasing', async () => {
    const { owner, storage } = fixture();
    await accept(owner);
    request.mockImplementationOnce(async () => {
      await accept(owner, { ...receipt, requestId: 'second-request', userTaskId: 'second-task' });
      return { value: { taskStore: { id: receipt.userTaskId, profile_id: receipt.profileId, status: 'done' } } };
    });
    expect(await owner._pollRunFinishedIfIdle(0)).toBe(false);
    expect(await storage.get('busy')).toBe(true);
  });

  it('retains launch items after adapter error and does not call a legacy judge', async () => {
    const { owner, storage } = fixture();
    await storage.put('buf', items);
    handleMessage.mockRejectedValue(new Error('unknown admission'));
    await owner._dispatch();
    expect(await storage.get('busy')).toBe(true);
    expect(await storage.get('launching')).toEqual(items);
    expect(await storage.get('retryBatch')).toBeUndefined();
    await owner._consultGate(42);
    expect(checkCompleteness).not.toHaveBeenCalled();
  });

  it('accepts persisted adapter acknowledgement and keeps ownership until task status', async () => {
    const { owner, storage } = fixture();
    await storage.put('buf', items);
    handleMessage.mockImplementationOnce(async (message, env, options) => {
      expect(message.intakeItems).toEqual(items);
      await accept(owner);
      options.onRunAccepted({ taskId: receipt.userTaskId, userTaskId: receipt.userTaskId,
        requestId: receipt.requestId, durable: true, controlPlane: true, routingPending: true });
    });
    await owner._dispatch();
    expect(await storage.get('busy')).toBe(true);
    expect(await storage.get('launching')).toBeUndefined();
    expect(await storage.get('cpUnresolvedLaunches')).toEqual([]);
    expect(await storage.get('cpBusyRequests')).toEqual([receipt.requestId]);
    expect(send).toHaveBeenCalledWith('test-bot-token', 42,
      '📨 Передаю собранный ввод на определение интента…', expect.any(Array), expect.any(Object));
    expect(await owner._pollRunFinishedIfIdle(0)).toBe(true);
  });

  it('does not discard unpersisted acknowledgement or unresolved parallel batch after restart', async () => {
    const { owner, storage, env } = fixture();
    await storage.put('buf', items);
    handleMessage.mockImplementationOnce(async (message, inputEnv, options) => {
      options.onRunAccepted({ taskId: receipt.userTaskId, userTaskId: receipt.userTaskId,
        requestId: receipt.requestId, durable: true, controlPlane: true });
    });
    await owner._dispatch();
    expect(await storage.get('launching')).toEqual(items);
    await accept(owner);
    await storage.put('buf', [{ text: 'second', msg: { message_id: 2, chat: { id: 42 }, text: 'second' } }]);
    await storage.put('launchParallel', true);
    handleMessage.mockRejectedValueOnce(new Error('unknown second admission'));
    await owner._dispatch();
    const restarted = new IntakeBuffer({ storage }, env);
    expect(await restarted._pollRunFinishedIfIdle(0)).toBe(false);
    expect(await storage.get('busy')).toBe(true);
    expect((await storage.get('launching'))[0].msg.message_id).toBe(2);
    expect(request).not.toHaveBeenCalled();
  });

  it('reconciles a replay using an already persisted receipt without a second registration', async () => {
    const { owner, storage } = fixture();
    await accept(owner);
    expect(await owner._pollRunFinishedIfIdle(0)).toBe(true);
    await storage.put('buf', items);
    handleMessage.mockImplementationOnce(async (message, env, options) => {
      const persisted = await (await owner.fetch(rpc(`/cp-acceptance?requestId=${receipt.requestId}`))).json();
      options.onRunAccepted({ taskId: persisted.receipt.userTaskId, userTaskId: persisted.receipt.userTaskId,
        requestId: persisted.receipt.requestId, durable: true, controlPlane: true });
    });
    await owner._dispatch();
    expect(await storage.get('cpUnresolvedLaunches')).toEqual([]);
    expect(await owner._pollRunFinishedIfIdle(0)).toBe(true);
    expect(await storage.get('busy')).toBeUndefined();
  });

  it.each(['lost-intake-ack', 'receipt-save-failed', 'index-save-failed'])('cold alarm recovers %s with the same source, snapshot and request', async failure => {
    const { owner, storage, env } = fixture();
    await storage.put('buf', items);
    handleMessage.mockImplementationOnce(async () => {
      await snapshot(owner);
      if (failure === 'index-save-failed') await accept(owner);
      throw new Error(failure);
    });
    await owner._dispatch();
    const frozen = await owner._readSnapshot(receipt.requestId);
    expect(await storage.get('busy')).toBe(true);
    expect((await storage.get('cpUnresolvedLaunches')).length).toBe(1);
    request.mockResolvedValue({ value: { taskStore: { id: receipt.userTaskId, profile_id: receipt.profileId, status: 'running' } } });
    const restarted = new IntakeBuffer({ storage }, env);
    handleMessage.mockImplementationOnce(async (message, inputEnv, options) => {
      expect(message.intakeItems).toEqual(items);
      expect(options.initialMsgId).toBe(99);
      expect(await restarted._readSnapshot(receipt.requestId)).toEqual(frozen);
      await accept(restarted);
      options.onRunAccepted({ taskId: receipt.userTaskId, userTaskId: receipt.userTaskId,
        requestId: receipt.requestId, durable: true, controlPlane: true, routingPending: true });
    });
    await restarted.alarm();
    expect(handleMessage).toHaveBeenCalledTimes(2);
    expect(await storage.get('busy')).toBe(true);
    expect(await storage.get('cpUnresolvedLaunches')).toEqual([]);
    expect(await storage.get('cpBusyRequests')).toEqual([receipt.requestId]);
    expect(await restarted._readSnapshot(receipt.requestId)).toEqual(frozen);
    expect(route).toHaveBeenCalledWith(receipt.userTaskId);
  });

  it('does not treat stored receipt plus failed index registration as completed admission', async () => {
    const { owner, storage, env } = fixture();
    await storage.put('buf', items);
    handleMessage.mockImplementation(async () => {
      await accept(owner);
      throw new Error('index unavailable');
    });
    await owner._dispatch();
    const restarted = new IntakeBuffer({ storage }, env);
    await restarted.alarm();
    expect(await storage.get('busy')).toBe(true);
    expect(await storage.get('launching')).toEqual(items);
    expect(request).not.toHaveBeenCalled();
    expect(send.mock.calls.filter(call => String(call[2]).includes('Подтверждение не получено'))).toHaveLength(1);
  });

  it('restores unsupported media for explicit retry without periodic admission attempts', async () => {
    const { owner, storage } = fixture();
    const media = [{ msg: { message_id: 7, chat: { id: 42 }, document: { file_id: 'offline-file' } }, text: 'document' }];
    await storage.put('buf', media);
    handleMessage.mockRejectedValue(Object.assign(new Error('unsupported media'), { code: 'INTAKE_PREPARATION_FAILED' }));
    await owner._dispatch();
    expect(await storage.get('busy')).toBeUndefined();
    expect(await storage.get('cpUnresolvedLaunches')).toBeUndefined();
    expect((await storage.get('retryBatch'))[0].msg).toEqual(media[0].msg);
    expect(send.mock.calls.some(call => String(call[2]).includes('задача не запущена'))).toBe(true);
    await owner.alarm();
    await owner.alarm();
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(route).not.toHaveBeenCalled();
    await owner._dispatch();
    expect(handleMessage).toHaveBeenCalledTimes(2);
    expect((await storage.get('retryBatch'))[0].msg).toEqual(media[0].msg);
  });

  it('keeps a preparation-labelled error unknown once a frozen admission snapshot exists', async () => {
    const { owner, storage } = fixture();
    await storage.put('buf', items);
    handleMessage.mockImplementationOnce(async () => {
      await snapshot(owner);
      throw Object.assign(new Error('ambiguous'), { code: 'INTAKE_PREPARATION_FAILED' });
    });
    await owner._dispatch();
    expect(await storage.get('busy')).toBe(true);
    expect(await storage.get('retryBatch')).toBeUndefined();
    expect(await storage.get('launching')).toEqual(items);
  });

  it('keeps quiet timer and dispatches whole input without legacy classifier', async () => {
    const { owner, storage } = fixture();
    await owner.fetch(rpc('/append', { text: 'first', msg: items[0].msg }));
    expect(await storage.get('receiptDue')).toBeGreaterThan(Date.now());
    expect(await storage.get('debounceExpiresAt')).toBeGreaterThan(Date.now() + 170_000);
    await storage.put('receiptDue', Date.now() - 1);
    await owner.alarm();
    expect(send).toHaveBeenCalledWith('test-bot-token', 42, expect.any(String), expect.any(Array), expect.any(Object));
    await storage.put('debounceExpiresAt', Date.now() - 1);
    await owner.alarm();
    expect(handleMessage).toHaveBeenCalledWith(expect.objectContaining({ intakeItems: items }), expect.anything(), expect.anything());
    expect(checkCompleteness).not.toHaveBeenCalled();
  });

  it('keeps durable message/update ownership across launch, completion and reconstruction', async () => {
    const { owner, storage, env } = fixture();
    const append = () => rpc('/append', { text: 'first', msg: items[0].msg, telegramUpdateId: 100 });
    await owner.fetch(append());
    handleMessage.mockImplementationOnce(async (message, inputEnv, options) => {
      const duplicate = await (await owner.fetch(append())).json();
      expect(duplicate.duplicate).toBe(true);
      await accept(owner);
      options.onRunAccepted({ taskId: receipt.userTaskId, userTaskId: receipt.userTaskId,
        requestId: receipt.requestId, durable: true, controlPlane: true });
    });
    await owner._dispatch();
    await owner._pollRunFinishedIfIdle(0);
    const restarted = new IntakeBuffer({ storage }, env);
    expect(await (await restarted.fetch(append())).json()).toEqual({ duplicate: true });
    expect(await storage.get('buf')).toBeUndefined();
    const reusedUpdate = await restarted.fetch(rpc('/append', {
      text: 'changed', msg: { ...items[0].msg, message_id: 2 }, telegramUpdateId: 100,
    }));
    expect(await reusedUpdate.json()).toEqual({ duplicate: true });
    expect(await storage.get('cp-input-update:100')).toEqual(expect.objectContaining({ messageId: 1 }));
    expect(handleMessage).toHaveBeenCalledTimes(1);
  });

  it('fences collector ACK loss across alarms/reconstruction without blocking explicit launch', async () => {
    const { owner, storage, env } = fixture();
    await owner.fetch(rpc('/append', { text: 'first', msg: items[0].msg, telegramUpdateId: 100 }));
    send.mockRejectedValue(new Error('ack lost'));
    await storage.put('receiptDue', Date.now() - 1);
    await owner.alarm();
    const batch = await storage.get('pendingBatch');
    expect(await storage.get(`cp-collector-send:${batch.batchId}`)).toEqual({ state: 'unknown' });
    const restarted = new IntakeBuffer({ storage }, env);
    await storage.put('receiptDue', Date.now() - 1);
    await restarted.alarm();
    expect(send).toHaveBeenCalledTimes(1);
    handleMessage.mockImplementationOnce(async (message, inputEnv, options) => {
      expect(options.collectorStatusHandled).toBe(true);
      expect(await storage.get(`cp-launch:${JSON.stringify([1])}`)).toEqual(expect.objectContaining({
        msg: expect.objectContaining({ intakeItems: [expect.objectContaining({ msg: items[0].msg, telegramUpdateId: 100 })] }),
      }));
      await accept(restarted);
      options.onRunAccepted({ taskId: receipt.userTaskId, userTaskId: receipt.userTaskId,
        requestId: receipt.requestId, durable: true, controlPlane: true });
    });
    await restarted._dispatch();
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('persists launch checkpoint before external collector send and prevents warm recovery overlap', async () => {
    const { owner, storage } = fixture();
    await storage.put('buf', items);
    send.mockImplementationOnce(async () => {
      const key = JSON.stringify([1]);
      expect(await storage.get(`cp-launch:${key}`)).toEqual(expect.objectContaining({ initialMsgId: null, msg: expect.objectContaining({ intakeItems: items }) }));
      expect(await storage.get('cpUnresolvedLaunches')).toEqual([key]);
      expect(await owner._pollRunFinishedIfIdle(0)).toBe(false);
      expect(handleMessage).not.toHaveBeenCalled();
      throw new Error('collector ack lost');
    });
    handleMessage.mockResolvedValue(undefined);
    await owner._dispatch();
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(handleMessage.mock.calls[0][2].collectorStatusHandled).toBe(true);
  });

  it('pins real confirmation ownership to exact source, mode and current busy task tuple', async () => {
    const { owner, storage } = fixture();
    owner.env.SESSIONS = { get: async key => key === '42' ? JSON.stringify({ username: 'test-profile' }) : null, put: async () => {} };
    await storage.put('buf', items);
    await storage.put('collectorMsgId', 99);
    await accept(owner);
    const registration = { sourceMessageId: 99, messageId: 150, callbackData: 'intake_stopsupp', username: 'test-profile' };
    expect((await owner.fetch(rpc('/callback-confirmation', registration))).status).toBe(200);
    const source = { messageId: 150, callbackData: 'intake_stopyes|supp', username: 'test-profile' };
    expect(await (await owner.fetch(rpc('/callback-owner', source))).json()).toEqual({ owned: true });
    expect(await (await owner.fetch(rpc('/callback-owner', { ...source, callbackData: 'intake_stopyes|new' }))).json()).toEqual({ owned: false });
    expect(await (await owner.fetch(rpc('/callback-owner', { ...source, messageId: 151 }))).json()).toEqual({ owned: false });
    await storage.put('cpBusyRequests', ['changed-task-request']);
    expect(await (await owner.fetch(rpc('/callback-owner', source))).json()).toEqual({ owned: false });
    await storage.put('cpBusyRequests', [receipt.requestId]);
    await storage.put('collectorMsgId', 100);
    expect(await (await owner.fetch(rpc('/callback-owner', source))).json()).toEqual({ owned: false });
  });

  it('requires current preparing source, active task and its exact snapshot for status stop buttons', async () => {
    const { owner, storage } = fixture();
    owner.env.SESSIONS = { get: async key => key === '42' ? JSON.stringify({ username: 'test-profile' }) : null, put: async () => {} };
    await storage.put('buf', items);
    await storage.put('preparingMsgId', 99);
    await accept(owner);
    const source = { messageId: 99, callbackData: `stop|${receipt.userTaskId}`, username: 'test-profile' };
    expect(await (await owner.fetch(rpc('/callback-owner', source))).json()).toEqual({ owned: false });
    await storage.put('input-message:99', receipt.requestId);
    expect(await (await owner.fetch(rpc('/callback-owner', source))).json()).toEqual({ owned: true });
    await storage.put('cpBusyRequests', []);
    expect(await (await owner.fetch(rpc('/callback-owner', source))).json()).toEqual({ owned: false });
  });

  it('pins session selector first-wins across concurrent requests and restart', async () => {
    const { owner, storage, env } = fixture();
    const requestId = `tg-${'a'.repeat(64)}`;
    const responses = await Promise.all(['first-session', 'later-session'].map(sessionId =>
      owner.fetch(rpc('/cp-session', { requestId, sessionId }))));
    expect(await responses[0].json()).toEqual({ sessionId: 'first-session' });
    expect(await responses[1].json()).toEqual({ sessionId: 'first-session' });
    const restarted = new IntakeBuffer({ storage }, env);
    expect(await (await restarted.fetch(rpc('/cp-session', { requestId, sessionId: 'third-session' }))).json()).toEqual({ sessionId: 'first-session' });
    expect((await restarted.fetch(rpc('/cp-session', { requestId: 'arbitrary', sessionId: 'session' }))).status).toBe(400);
  });
});
