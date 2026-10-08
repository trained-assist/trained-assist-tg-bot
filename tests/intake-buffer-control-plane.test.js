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
  controlPlaneClient: () => ({ config: { profileId: 'test-profile', botUsername: 'test-bot' }, route, request, stopTargets }),
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
  it('lets the owner dismiss waiting on one unknown launch without deleting its evidence or retrying it', async () => {
    const { owner, storage, env } = fixture();
    const token = '123e4567-e89b-42d3-a456-426614174000';
    const launchKey = '[1]';
    owner.env.SESSIONS = { get: async key => key === '42' ? JSON.stringify({ username: 'test-profile' }) : null, put: async () => {} };
    await storage.put('launching', items);
    await storage.put('cpUnresolvedLaunches', [launchKey]);
    await storage.put(`cp-launch:${launchKey}`, { msg: { ...items[0].msg, intakeItems: items }, profileId: 'test-profile', botUsername: 'test-bot' });
    await storage.put('cpStopWindow', { pending: true, intentId: 'stop-intent', username: 'test-profile', chatId: 42,
      threadId: null, profileId: 'test-profile', admissionLaunchKeys: [launchKey] });
    await storage.put(`cp-unknown-dismiss:${token}`, { launchKey, intentId: 'stop-intent', username: 'test-profile', messageId: 99 });
    const callback = { messageId: 99, callbackData: `intake_dismiss_unknown|${token}`, username: 'test-profile' };
    expect(await (await owner.fetch(rpc('/callback-owner', callback))).json()).toEqual({ owned: true });
    const response = await owner.fetch(rpc('/dismiss-unknown', callback));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ dismissed: true, outcomeUnknown: true });
    expect(await storage.get('cpUnresolvedLaunches')).toEqual([launchKey]);
    expect(await storage.get(`cp-launch:${launchKey}`)).toMatchObject({ userDismissed: true });
    expect(await storage.get('cpStopWindow')).toMatchObject({ pending: true, userDismissedLaunchKeys: [launchKey] });
    expect(await owner._activeUnresolvedLaunches()).toEqual([]);
    await owner._recoverControlPlaneLaunch();
    expect(handleMessage).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith('test-bot-token', 42, expect.stringContaining('исход остаётся неизвестным'), expect.objectContaining({}));

    await storage.put('buf', [{ text: 'новая задача', msg: { chat: { id: 42 }, message_id: 2, text: 'новая задача' } }]);
    await storage.put('draftRevision', 3);
    await owner._showCollector(42, 1, 2);
    const launch = { messageId: 99, callbackData: 'ws|answer|3', username: 'test-profile' };
    expect(await owner._callbackOwned(launch)).toBe(true);
    const launched = await owner.fetch(rpc('/flush', { parallel: true, ...launch }));
    expect(launched.status).toBe(200);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(handleMessage.mock.calls[0][0].text).toBe('новая задача');
    expect(handleMessage.mock.calls[0][2]).toMatchObject({ parallel: true, workStyle: 'answer' });
    expect(await storage.get('cpUnresolvedLaunches')).toEqual([launchKey, '[2]']);
  });

  it.each(['stop-disabled', 'busy'])('real %s scheduling preserves an earlier alarm even without cleanup entries', async branch => {
    const { storage, env } = fixture();
    env.TG_SLICE_STOP_ENABLED = 'false';
    const earlier = Date.now() + 1000;
    await storage.setAlarm(earlier);
    if (branch === 'busy') await storage.put('busy', true);
    else await storage.put('cpStopWindow', { pending: true, intentId: 'deferred-stop' });
    await new IntakeBuffer({ storage }, env).alarm();
    expect(await storage.getAlarm()).toBe(earlier);
    expect(request).not.toHaveBeenCalled();
    expect(stopTargets).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
  });

  it.each([null, -1000, 120000, 1000])('real cleanup preserves an earlier alarm and replaces absent/expired/later alarms: %s', async offset => {
    const { storage, env } = fixture();
    const before = Date.now();
    const scheduled = offset === null ? null : before + offset;
    if (scheduled !== null) await storage.setAlarm(scheduled);
    await storage.put('cpCollectorCleanupRequests', [receipt.requestId]);
    await storage.put(`cp-collector-cleanup:${receipt.requestId}`, { requestId: receipt.requestId,
      profileId: receipt.profileId, state: 'pending', messageId: 99, chatId: 42, text: 'Terminal collector status' });
    await storage.put('input-message:99', receipt.requestId);
    edit.mockRejectedValue(new Error('lost edit acknowledgement'));
    await new IntakeBuffer({ storage }, env).alarm();
    expect(edit).toHaveBeenCalledTimes(1);
    if (offset === 1000) expect(await storage.getAlarm()).toBe(scheduled);
    else {
      expect(await storage.getAlarm()).toBeGreaterThanOrEqual(before + 60000);
      expect(await storage.getAlarm()).toBeLessThanOrEqual(Date.now() + 60000);
    }
    expect(await storage.get('cpCollectorCleanupRequests')).toEqual([receipt.requestId]);
  });

  it('parked re-offer still deletes its alarm after all terminal cleanup edits finish', async () => {
    const { storage, env } = fixture();
    await storage.put(`cp-collector-cleanup:${receipt.requestId}`, { requestId: receipt.requestId,
      profileId: receipt.profileId, state: 'pending', messageId: 99, chatId: 42, text: 'Terminal collector status' });
    await storage.put('input-message:99', receipt.requestId);
    await storage.put('cpCollectorCleanupRequests', [receipt.requestId]);
    await storage.put('parkedAt', Date.now() - 16 * 60_000);
    await new IntakeBuffer({ storage }, env).alarm();
    expect(await storage.get('cpCollectorCleanupRequests')).toEqual([]);
    expect(await storage.get('parkReoffers')).toBe(1);
    expect(await storage.getAlarm()).toBeUndefined();
  });

  it('cold parked re-offer preserves the alarm for an unknown terminal cleanup edit ACK', async () => {
    const { storage, env } = fixture();
    const intent = { requestId: receipt.requestId, profileId: receipt.profileId,
      state: 'pending', messageId: 99, chatId: 42, text: 'Terminal collector status' };
    await storage.put(`cp-collector-cleanup:${receipt.requestId}`, intent);
    await storage.put(`input-message:99`, receipt.requestId);
    await storage.put('cpCollectorCleanupRequests', [receipt.requestId]);
    await storage.put('parkedAt', Date.now() - 16 * 60_000);
    await storage.put('buf', items);
    await storage.put('collectorMsgId', 100);
    edit.mockImplementation(async (_token, _chatId, messageId) => {
      if (messageId === 99) throw new Error('lost edit acknowledgement');
      return { ok: true };
    });
    await new IntakeBuffer({ storage }, env).alarm();
    expect(await storage.get('parkReoffers')).toBe(1);
    expect(await storage.get('buf')).toEqual(items);
    expect(await storage.get('cpCollectorCleanupRequests')).toEqual([receipt.requestId]);
    expect(await storage.getAlarm()).toBeGreaterThan(Date.now());
    const originalEdit = edit.mock.calls.find(call => call[2] === 99);
    edit.mockResolvedValue({ ok: true });
    await new IntakeBuffer({ storage }, env).alarm();
    expect(edit.mock.calls.filter(call => call[2] === 99)).toEqual([originalEdit, originalEdit]);
    expect(await storage.get('cpCollectorCleanupRequests')).toEqual([]);
    expect((await storage.get(`cp-collector-cleanup:${receipt.requestId}`)).state).toBe('done');
    expect(enqueue).not.toHaveBeenCalled();
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it.each(['invalid', 'failed'])('cold cleanup reaches later entries despite eight permanently %s entries', async kind => {
    const { owner, storage, env } = fixture();
    const blocked = Array.from({ length: 8 }, (_, index) => `blocked-${index}`);
    await storage.put('cpCollectorCleanupRequests', [...blocked, 'later-request']);
    for (const [index, requestId] of [...blocked, 'later-request'].entries()) {
      await storage.put(`cp-collector-cleanup:${requestId}`, { requestId, state: 'pending',
        profileId: kind === 'invalid' && index < 8 ? 'wrong-profile' : 'test-profile',
        messageId: index + 1, chatId: 42, text: requestId });
      await storage.put(`input-message:${index + 1}`, requestId);
    }
    edit.mockImplementation(async (_token, _chatId, messageId) => ({ ok: messageId === 9 }));
    await owner._recoverControlPlaneCollectorCleanup();
    expect(edit.mock.calls.some(call => call[2] === 9)).toBe(false);
    const restarted = new IntakeBuffer({ storage }, env);
    await restarted._recoverControlPlaneCollectorCleanup();
    expect(edit.mock.calls.filter(call => call[2] === 9)).toHaveLength(1);
    expect((await storage.get('cp-collector-cleanup:later-request')).state).toBe('done');
    expect(new Set(await storage.get('cpCollectorCleanupRequests'))).toEqual(new Set(blocked));
    for (const requestId of blocked) {
      expect((await storage.get(`cp-collector-cleanup:${requestId}`)).state).toBe('pending');
    }
    expect(send).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it.each(['done', 'failed', 'cancelled'])('cold completion finalizes the original collector without copying terminal output: %s', async status => {
    const { owner, storage, env } = fixture();
    await owner.fetch(rpc('/snapshot', { body: { username: 'test-profile', requestId: receipt.requestId, initialMsgId: 99,
      controlPlaneEnvelope: { requestId: receipt.requestId, profileId: receipt.profileId, conversationRef: 'tg-42-ssaved' } }, items }));
    await owner.fetch(rpc('/cp-acceptance', { requestId: receipt.requestId, receipt }));
    request.mockResolvedValue({ value: { taskStore: { id: receipt.userTaskId, profile_id: receipt.profileId,
      status, generation: 1, result: { answer: 'Only the terminal delivery contains this answer.' } } } });
    const restarted = new IntakeBuffer({ storage }, env);
    const frozen = await restarted._readSnapshot(receipt.requestId);
    expect(await restarted._pollRunFinishedIfIdle(0)).toBe(true);
    const text = status === 'done' ? '✅ Готово. Результат отправлен отдельным сообщением.'
      : status === 'failed' ? '❌ Задача завершилась ошибкой. Подробности отправлены отдельным сообщением.'
        : '⛔ Задача отменена. Статус отправлен отдельным сообщением.';
    expect(edit).toHaveBeenCalledWith(restarted.env.BOT_TOKEN, 42, 99, text,
      { reply_markup: { inline_keyboard: [[{ text: '📋 Посмотреть input', callback_data: 'input_run' }]] } });
    expect(await restarted._readSnapshot(receipt.requestId)).toEqual(frozen);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    await restarted.alarm();
    expect(edit).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('lost edit ACK releases the task and cold retry edits identical collector without terminal resend', async () => {
    const { owner, storage, env } = fixture();
    await owner.fetch(rpc('/snapshot', { body: { username: 'test-profile', requestId: receipt.requestId, initialMsgId: 99,
      controlPlaneEnvelope: { requestId: receipt.requestId, profileId: receipt.profileId, conversationRef: 'tg-42-ssaved' } }, items }));
    await owner.fetch(rpc('/cp-acceptance', { requestId: receipt.requestId, receipt }));
    edit.mockRejectedValueOnce(new Error('lost edit acknowledgement'));
    expect(await owner._pollRunFinishedIfIdle(0)).toBe(true);
    expect(await storage.get('busy')).toBeUndefined();
    expect(await storage.get('cpCollectorCleanupRequests')).toEqual([receipt.requestId]);
    const originalEdit = edit.mock.calls[0];
    edit.mockResolvedValueOnce({ ok: false, error_code: 400, description: 'Bad Request: message is not modified' });
    const restarted = new IntakeBuffer({ storage }, env);
    await restarted.alarm();
    expect(edit.mock.calls[1]).toEqual(originalEdit);
    expect(await storage.get('cpCollectorCleanupRequests')).toEqual([]);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    await restarted.alarm();
    expect(edit).toHaveBeenCalledTimes(2);
  });

  it('cleanup does not edit a newer collector or mutate retained next-batch input', async () => {
    const { owner, storage } = fixture();
    await owner.fetch(rpc('/snapshot', { body: { username: 'test-profile', requestId: receipt.requestId, initialMsgId: 99,
      controlPlaneEnvelope: { requestId: receipt.requestId, profileId: receipt.profileId, conversationRef: 'tg-42-ssaved' } }, items }));
    await owner.fetch(rpc('/cp-acceptance', { requestId: receipt.requestId, receipt }));
    await storage.put('collectorMsgId', 100);
    await storage.put('preparingMsgId', 100);
    await storage.put('buf', items);
    expect(await owner._pollRunFinishedIfIdle(0)).toBe(true);
    expect(edit.mock.calls.some(call => call[2] === 99 && call[3].startsWith('✅'))).toBe(true);
    expect(edit.mock.calls.some(call => call[2] === 100 && call[3].startsWith('✅'))).toBe(false);
    expect(await storage.get('preparingMsgId')).toBe(100);
    expect(await storage.get('buf')).toEqual(items);
  });

  it('unverified not-modified response retains cleanup pending instead of declaring success', async () => {
    const { owner, storage } = fixture();
    await owner.fetch(rpc('/snapshot', { body: { username: 'test-profile', requestId: receipt.requestId, initialMsgId: 99,
      controlPlaneEnvelope: { requestId: receipt.requestId, profileId: receipt.profileId, conversationRef: 'tg-42-ssaved' } }, items }));
    await owner.fetch(rpc('/cp-acceptance', { requestId: receipt.requestId, receipt }));
    edit.mockResolvedValueOnce({ ok: false, error_code: 500, description: 'message is not modified' });
    expect(await owner._pollRunFinishedIfIdle(0)).toBe(true);
    expect(await storage.get('cpCollectorCleanupRequests')).toEqual([receipt.requestId]);
    expect((await storage.get(`cp-collector-cleanup:${receipt.requestId}`)).state).toBe('pending');
  });

  it('keeps a visible receipt scheduled when a stop-launch hold blocks auto-dispatch', async () => {
    const { owner, storage } = fixture();
    owner.env.BOT_TOKEN = 'test-bot-token';
    owner.env.TG_SLICE_STOP_ENABLED = 'false';
    await storage.put('stopLaunch', { mode: 'new', at: Date.now() });
    const response = await owner.fetch(rpc('/append', {
      text: 'ping', msg: { chat: { id: 42 }, message_id: 17, text: 'ping' }, telegramUpdateId: 117,
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ buffered: 1 });
    expect(await storage.get('debounceExpiresAt')).toBeUndefined();
    expect(await storage.get('receiptDue')).toBeGreaterThan(Date.now());
    expect(await storage.getAlarm()).toBe(await storage.get('receiptDue'));

    await storage.put('receiptDue', Date.now() - 1);
    await owner.alarm();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][2]).toContain('1 сообщ.');
    expect(handleMessage).not.toHaveBeenCalled();
  });

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
    if (kind === 'inflight') {
      owner.cpDispatches = 1;
      await storage.put('cpStopWindow', { ...(await storage.get('cpStopWindow')), admissionLaunchKeys: ['unknown-batch'] });
      await storage.put('cpUnresolvedLaunches', ['unknown-batch']);
    }
    if (kind === 'unknown-launch') {
      await storage.put('cpStopWindow', { ...(await storage.get('cpStopWindow')), admissionLaunchKeys: ['unknown-batch'] });
      await storage.put('cpUnresolvedLaunches', ['unknown-batch']);
    }
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
    await storage.put('cpStopWindow', { ...(await storage.get('cpStopWindow')), admissionLaunchKeys: [launchKey] });
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
    const keyboard = send.mock.calls.at(-1)[3].flat();
    const buttons = keyboard.map(button => button.callback_data.split('|')[0]);
    expect(keyboard.map(button => button.callback_data)).toEqual(expect.arrayContaining([
      'ws|explore|1', 'ws|answer|1', 'ws|auto|1', 'intake_parallel', 'input_draft',
    ]));
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

  it('offers an independent launch while stop reconciliation is unresolved', async () => {
    const { owner, storage, source } = await stopFixture();
    await owner.fetch(rpc('/stop', source));
    const stopWindow = await storage.get('cpStopWindow');
    await storage.put('cpStopWindow', { ...stopWindow, admissionLaunchKeys: ['[1]'] });
    await storage.put('cpUnresolvedLaunches', ['[1]']);
    await storage.put('cp-launch:[1]', { profileId: 'test-profile', botUsername: 'test-bot', msg: items[0].msg });
    await storage.put('buf', [{ text: 'held', msg: { chat: { id: 42 }, message_id: 2, text: 'held' } }]);
    await owner._showCollector(42, 1, 2, null, '⛔ Остановлено');
    expect(send.mock.calls.at(-1)[2]).toBe('⏳ Старая задача ещё сверяется. Этот независимый ввод можно запустить отдельно.');
    const callbacks = send.mock.calls.at(-1)[3].flat().map(button => button.callback_data);
    expect(callbacks).toContain(`ws|answer|${await storage.get('draftRevision')}`);
    expect(callbacks.some(value => /^intake_dismiss_unknown\|[a-f0-9-]{36}$/.test(value))).toBe(true);
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('recovers a missing pending-stop collector on the next draft revision after an unknown send', async () => {
    const { owner, storage } = fixture();
    const batch = await owner._batchIdLocked(42, null);
    await storage.put('cpStopWindow', { pending: true, intentId: 'stop-window' });
    await storage.put('buf', [{ text: 'held', msg: { chat: { id: 42 }, message_id: 2, text: 'held' } }]);
    await storage.put('draftRevision', 4);
    await storage.put(`cp-collector-send:${batch.batchId}`, { state: 'unknown' });

    await owner._showCollector(42, 1, 2);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls.at(-1)[3].flat().map(button => button.callback_data)).toContain('ws|auto|4');
    expect(await storage.get(`cp-collector-send:${batch.batchId}`)).toEqual({ state: 'unknown' });
    expect(await storage.get(`cp-collector-send:${batch.batchId}:r4`)).toEqual({ state: 'sent', messageId: 99 });
    expect(await storage.get('collectorMsgId')).toBe(99);

    await storage.put('buf', [
      { text: 'held', msg: { chat: { id: 42 }, message_id: 2, text: 'held' } },
      { text: 'new', msg: { chat: { id: 42 }, message_id: 3, text: 'new' } },
    ]);
    await storage.put('draftRevision', 5);
    edit.mockResolvedValueOnce({ ok: false, description: "Bad Request: message can't be edited" });
    await owner._showCollector(42, 2, 3);

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.at(-1)[3].flat().map(button => button.callback_data)).toContain('ws|auto|5');
    expect(await storage.get(`cp-collector-send:${batch.batchId}:r5`)).toEqual({ state: 'sent', messageId: 99 });
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it.each(['queued', 'stopLaunch'])('keeps independent launch controls visible despite stale %s state', async staleState => {
    const { owner, storage, source } = await stopFixture();
    await owner.fetch(rpc('/stop', source));
    await storage.put('buf', [{ text: 'held', msg: { chat: { id: 42 }, message_id: 2, text: 'held' } }]);
    if (staleState === 'queued') await storage.put('launchQueued', true);
    else await storage.put('stopLaunch', { mode: 'new', route: 'old-route', at: Date.now() });
    await owner._showCollector(42, 1, 2);
    const callbacks = send.mock.calls.at(-1)[3].flat().map(button => button.callback_data);
    expect(callbacks).toContain(`ws|answer|${await storage.get('draftRevision')}`);
    expect(callbacks).not.toContain('intake_cancel');
    expect((await storage.get('cpStopWindow')).pending).toBe(true);
  });

  it('sends a fresh independent-launch collector if Telegram cannot edit the prior bubble', async () => {
    const { owner, storage, source } = await stopFixture();
    await owner.fetch(rpc('/stop', source));
    await storage.put('collectorMsgId', 999);
    await storage.put('collectorBatchId', 'old-batch');
    await storage.put('buf', [{ text: 'held', msg: { chat: { id: 42 }, message_id: 2, text: 'held' } }]);
    edit.mockResolvedValueOnce({ ok: false, description: 'message to edit not found' });
    await owner._showCollector(42, 1, 2);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls.at(-1)[3].flat().map(button => button.callback_data)).toContain(`ws|answer|${await storage.get('draftRevision')}`);
    expect(await storage.get('collectorMsgId')).toBe(99);
  });

  it('retains stopped task identities across terminal polling and restart; independent input launches without waiting', async () => {
    const { owner, storage, env, source } = await stopFixture();
    env.SESSIONS = owner.env.SESSIONS;
    expect((await owner.fetch(rpc('/stop', source))).status).toBe(200);
    expect((await storage.get('cpStopWindow')).pending).toBe(true);
    expect(await owner._pollRunFinishedIfIdle(0)).toBe(true);
    expect(route).not.toHaveBeenCalled();
    expect(await storage.get('cpBusyRequests')).toBeUndefined();
    const restarted = new IntakeBuffer({ storage }, env);
    stopTargets.mockImplementationOnce(async input => ({ snapshotId: 'snapshot-test', profileId: receipt.profileId,
      conversationId: input.conversationId, tasks: [{ requestId: receipt.requestId, userTaskId: receipt.userTaskId,
        profileId: receipt.profileId, receiptId: 'receipt:test' }], unresolved: true, stopConfirmed: false, reason: 'native_stop_unknown' }));
    const targets = await (await restarted.fetch(rpc('/cp-stop-targets', source))).json();
    expect(targets.tasks).toEqual([{ requestId: receipt.requestId, userTaskId: receipt.userTaskId,
      profileId: receipt.profileId, receiptId: 'receipt:test' }]);
    expect(targets.unresolved).toBe(true);
    await restarted.fetch(rpc('/append', { text: 'запускай', msg: { chat: { id: 42 }, message_id: 2, text: 'запускай' }, telegramUpdateId: 102, flush: true }));
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(handleMessage.mock.calls[0][2]).toMatchObject({ parallel: true });
    expect(await storage.get('stopped')).toBeUndefined();
    expect((await storage.get('buf')) || []).toEqual([]);
    expect((await storage.get('cpStopWindow')).pending).toBe(true);
  });

  it('stop clears only the local unlaunched draft and keeps old task evidence for reconciliation', async () => {
    const { owner, storage, source } = await stopFixture();
    const draft = [{ text: 'discarded draft', msg: { chat: { id: 42 }, message_id: 3, text: 'discarded draft' } }];
    await storage.put('buf', draft);
    const beforeTasks = (await storage.get('cpStopWindow')).tasks;
    const result = await (await owner.fetch(rpc('/stop', source))).json();
    expect(result).toMatchObject({ stopped: true, held: 0, clearedDraftCount: 1 });
    expect(await storage.get('buf')).toBeUndefined();
    expect(await storage.get('cpStopWindow')).toMatchObject({ pending: true, tasks: beforeTasks });
    expect(await storage.get('busy')).toBe(true);
  });

  it('launches stop-new as an independent task while the old stop is unconfirmed', async () => {
    const { owner, storage, env, source } = await stopFixture();
    env.SESSIONS = owner.env.SESSIONS;
    await storage.put('busy', true);
    await storage.put('busyChatId', 42);
    await storage.put('collectorMsgId', 99);
    await storage.put('cpBusyRequests', [receipt.requestId]);
    await storage.put('cp-confirmation:150', { username: 'test-profile', mode: 'new',
      requestIds: [receipt.requestId] });
    await storage.put('buf', [{ text: 'independent', msg: { chat: { id: 42 }, message_id: 2, text: 'independent' } }]);
    await storage.put('cpStopWindow', { ...(await storage.get('cpStopWindow')), pending: true, unresolved: true, stopConfirmed: false });
    const result = await owner.fetch(rpc('/stop-launch', { mode: 'new', ...source,
      messageId: 150, callbackData: 'intake_stopyes|new' }));
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ launching: true, count: 1 });
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(handleMessage.mock.calls[0][0].text).toBe('independent');
    expect(handleMessage.mock.calls[0][2]).toMatchObject({ parallel: true });
    const independent = { ...receipt, requestId: `tg-${'e'.repeat(64)}`, userTaskId: 'ut-independent' };
    const independentItems = handleMessage.mock.calls[0][0].intakeItems;
    await snapshot(owner, independent, independentItems);
    await accept(owner, independent);
    await owner._recordControlPlaneAck({ controlPlane: true, durable: true, requestId: independent.requestId,
      userTaskId: independent.userTaskId, taskId: independent.userTaskId }, independentItems);
    const preparedStop = await owner._readControlPlaneStopTargets(source);
    expect(preparedStop.tasks.map(task => task.userTaskId)).toEqual([receipt.userTaskId]);
    expect((await storage.get('cpStopWindow'))).toMatchObject({ pending: true, stopConfirmed: false,
      admissionRequestIds: [receipt.requestId] });
  });

  it('retries the same immutable CP stop window after an unknown admission barrier and updates the collector on confirmation', async () => {
    const { owner, storage, source } = await stopFixture();
    owner.cpDispatches = 1;
    await storage.put('cpStopWindow', { ...(await storage.get('cpStopWindow')), admissionLaunchKeys: ['inflight-launch'] });
    await storage.put('cpUnresolvedLaunches', ['inflight-launch']);
    const unresolved = await (await owner.fetch(rpc('/cp-stop-targets', source))).json();
    expect(unresolved).toMatchObject({ unresolved: true, stopConfirmed: false });
    expect(stopTargets).not.toHaveBeenCalled();
    owner.cpDispatches = 0;
    await storage.put('cpUnresolvedLaunches', []);
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
    const revision = await storage.get('draftRevision');
    const queued = await owner.fetch(rpc('/flush', { sourceMessageId: await storage.get('collectorMsgId'),
      callbackData: `ws|explore|${revision}`, username: 'test-profile' }));
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
    request.mockResolvedValue({ value: { taskStore: { id: receipt.userTaskId, profile_id: receipt.profileId, status: 'running' } } });
    const routed = { degraded: true, continuation: { issued } };
    route.mockResolvedValue(routed);
    expect(await owner._pollRunFinishedIfIdle(0)).toBe(false);
    expect(publishRoutingDegradation).toHaveBeenCalledWith(owner.env, receipt, routed,
      { chatId: 42, threadId: 17 }, `tg-42-ssaved-b${receipt.requestId.slice(-24)}`);
  });

  it('keeps ownership if degradation publication fails and retries the same cached route', async () => {
    const { owner, storage } = fixture();
    await accept(owner);
    request.mockResolvedValue({ value: { taskStore: { id: receipt.userTaskId, profile_id: receipt.profileId, status: 'running' } } });
    route.mockResolvedValue({ degraded: true, continuation: { issued: false } });
    publishRoutingDegradation.mockRejectedValueOnce(new Error('owner unavailable'));
    expect(await owner._pollRunFinishedIfIdle(0)).toBe(false);
    expect(await storage.get('busy')).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(await owner._pollRunFinishedIfIdle(0)).toBe(false);
    expect(route.mock.calls).toEqual([[receipt.userTaskId], [receipt.userTaskId]]);
    expect(publishRoutingDegradation).toHaveBeenCalledTimes(2);
    expect(await storage.get('busy')).toBe(true);
  });

  it('uses a neutral CP launch label without changing legacy labels or actions', async () => {
    const { owner, storage } = fixture();
    await storage.put('buf', items);
    await owner._showCollector(42, 1, 1);
    expect(send.mock.calls[0][3].flat().map(button => button.callback_data)).toEqual([
      'ws|explore|1', 'ws|answer|1', 'ws|auto|1', 'intake_discard|1',
    ]);
    send.mockClear();
    const legacy = new IntakeBuffer({ storage }, { BOT_TOKEN: 'legacy-token' });
    await storage.delete('collectorMsgId');
    await legacy._showCollector(42, 1, 1);
    expect(send.mock.calls[0][3].flat().every(button => typeof button.callback_data === 'string')).toBe(true);
  });

  it('launches the selected style once from the exact current draft revision', async () => {
    const { owner, storage } = fixture();
    owner.env.SESSIONS = { get: async key => key === '42' ? JSON.stringify({ username: 'test-profile' }) : null, put: async () => {} };
    await owner.fetch(rpc('/append', { text: 'Сравни два варианта', msg: items[0].msg, telegramUpdateId: 100 }));
    await owner._showCollector(42, 1, 1);
    const revision = await storage.get('draftRevision');
    const source = { sourceMessageId: await storage.get('collectorMsgId'), callbackData: `ws|explore|${revision}`, username: 'test-profile' };
    handleMessage.mockImplementationOnce(async (message, _env, options) => {
      expect(message.intakeItems.map(item => item.text)).toEqual(['Сравни два варианта']);
      expect(options.workStyle).toBe('explore');
      expect(options.workStyleSource).toBe('explicit');
      await snapshot(owner, receipt, message.intakeItems);
      await owner.fetch(rpc('/cp-acceptance', { requestId: receipt.requestId, receipt }));
      options.onRunAccepted({ taskId: receipt.userTaskId, userTaskId: receipt.userTaskId,
        requestId: receipt.requestId, durable: true, controlPlane: true });
    });
    expect((await owner.fetch(rpc('/flush', source))).status).toBe(200);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(await storage.get('launchWorkStyle')).toBeUndefined();
    expect((await owner.fetch(rpc('/flush', source))).status).toBe(409);
    expect(handleMessage).toHaveBeenCalledTimes(1);
  });

  it('rejects a style callback after any new input changes the draft revision', async () => {
    const { owner, storage } = fixture();
    owner.env.SESSIONS = { get: async key => key === '42' ? JSON.stringify({ username: 'test-profile' }) : null, put: async () => {} };
    await owner.fetch(rpc('/append', { text: 'first', msg: items[0].msg, telegramUpdateId: 100 }));
    await owner._showCollector(42, 1, 1);
    const oldRevision = await storage.get('draftRevision');
    await owner.fetch(rpc('/append', { text: 'second', msg: { chat: { id: 42 }, message_id: 2, text: 'second' }, telegramUpdateId: 101 }));
    const result = await owner.fetch(rpc('/flush', { sourceMessageId: await storage.get('collectorMsgId'),
      callbackData: `ws|answer|${oldRevision}`, username: 'test-profile' }));
    expect(result.status).toBe(409);
    expect(await storage.get('buf')).toHaveLength(2);
    expect(handleMessage).not.toHaveBeenCalled();
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

  it.each(['running', 'awaiting', undefined])('holds nonterminal %s beyond legacy lifetime', async status => {
    const { owner, storage } = fixture();
    await accept(owner);
    await storage.put('busy', true);
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

  it('releases intake after an unknown executor outcome without retrying or terminalizing the task', async () => {
    const { owner, storage } = fixture();
    await accept(owner);
    await storage.put('busy', true);
    await storage.put('cpBusyRequests', [receipt.requestId]);
    request.mockResolvedValue({ value: { taskStore: { id: receipt.userTaskId, profile_id: receipt.profileId,
      status: 'running', generation: 1 }, runs: [{ id: 'run-lost', status: 'unknown', generation: 1 }] } });

    expect(await owner._pollControlPlaneTasks()).toBe(true);
    expect(await storage.get('busy')).toBeUndefined();
    expect(await storage.get('cp-acceptance:scoped-request')).toMatchObject({ outcomeUnknown: true });
    expect(await storage.get('cp-acceptance:scoped-request')).toMatchObject({ terminal: false });
    expect(enqueue).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
  });

  it('keeps the busy hold while any parallel executor attempt is still active', async () => {
    const { owner, storage } = fixture();
    await accept(owner);
    await storage.put('busy', true);
    await storage.put('cpBusyRequests', [receipt.requestId]);
    request.mockResolvedValue({ value: { taskStore: { id: receipt.userTaskId, profile_id: receipt.profileId,
      status: 'running', generation: 2 }, runs: [
      { id: 'run-lost', status: 'unknown', generation: 1 },
      { id: 'run-live', status: 'running', generation: 2 },
    ] } });

    expect(await owner._pollControlPlaneTasks()).toBe(false);
    expect(await storage.get('busy')).toBe(true);
    expect(await storage.get('cp-acceptance:scoped-request')).not.toHaveProperty('outcomeUnknown');
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
    expect(route).not.toHaveBeenCalled();
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

  it('releases a terminal task even when route acknowledgement was never persisted', async () => {
    const { owner, storage } = fixture();
    await accept(owner);
    expect(await owner._pollRunFinishedIfIdle(0)).toBe(true);
    expect(await storage.get('busy')).toBeUndefined();
    expect((await storage.get(`cp-acceptance:${receipt.requestId}`)).terminal).toBe(true);
    expect(route).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith('POST', '/status', { body: { taskId: receipt.userTaskId } });
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('retains persisted routing outcome across restart without repeating notice enqueue', async () => {
    const { owner, storage, env } = fixture();
    await accept(owner);
    route.mockResolvedValue({ degraded: true, continuation: { issued: false } });
    request.mockResolvedValue({ value: { taskStore: { id: receipt.userTaskId, profile_id: receipt.profileId, status: 'running' } } });
    expect(await owner._pollRunFinishedIfIdle(0)).toBe(false);
    expect((await storage.get(`cp-acceptance:${receipt.requestId}`)).routingOutcome.publicationComplete).toBe(true);
    route.mockRejectedValue(new Error('later route transport outage'));
    const restarted = new IntakeBuffer({ storage }, env);
    expect(await restarted._pollRunFinishedIfIdle(0)).toBe(false);
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

  it.each([401, 403])('releases a launch after explicit CP auth rejection %i and preserves input for retry', async status => {
    const { owner, storage } = fixture();
    await storage.put('buf', items);
    handleMessage.mockRejectedValue(Object.assign(new Error(`control plane POST /intake -> ${status}`), {
      name: 'ControlPlaneError', status,
    }));

    await owner._dispatch();

    expect(await storage.get('busy')).toBeUndefined();
    expect(await storage.get('cpUnresolvedLaunches') ?? []).toEqual([]);
    expect(await storage.get('launching')).toBeUndefined();
    expect(await storage.get('retryBatch')).toEqual(items.map(item => ({ ...item, heldWhileBusy: true })));
    expect(send.mock.calls.some(call => String(call[2]).includes('Запуск не создавал'))).toBe(true);
    expect(send.mock.calls.some(call => String(call[2]).includes('Подтверждение запуска не получено. Не могу подтвердить'))).toBe(false);
    expect(checkCompleteness).not.toHaveBeenCalled();
  });

  it.each([408, 409, 429, 500, 503])('keeps ambiguous CP HTTP %i admission unresolved', async status => {
    const { owner, storage } = fixture();
    await storage.put('buf', items);
    handleMessage.mockRejectedValue(Object.assign(new Error(`control plane -> ${status}`), {
      name: 'ControlPlaneError', status,
    }));

    await owner._dispatch();

    expect(await storage.get('busy')).toBe(true);
    expect((await storage.get('cpUnresolvedLaunches'))).toHaveLength(1);
    expect(await storage.get('launching')).toEqual(items);
    expect(await storage.get('retryBatch')).toBeUndefined();
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

  it('refuses unsupported media and drops it instead of retrying the same failed batch', async () => {
    const { owner, storage } = fixture();
    const media = [{ msg: { message_id: 7, chat: { id: 42 }, document: { file_id: 'offline-file' } }, text: 'document' }];
    await storage.put('buf', media);
    handleMessage.mockRejectedValue(Object.assign(new Error('unsupported media'), { code: 'INTAKE_PREPARATION_FAILED' }));
    await owner._dispatch();
    expect(await storage.get('busy')).toBeUndefined();
    expect(await storage.get('cpUnresolvedLaunches')).toBeUndefined();
    expect(await storage.get('retryBatch')).toBeUndefined();
    expect(send.mock.calls.some(call => String(call[2]).includes('порцию сбросил'))).toBe(true);
    await owner.alarm();
    await owner.alarm();
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(route).not.toHaveBeenCalled();
    await owner._dispatch();
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(await storage.get('retryBatch')).toBeUndefined();
  });

  it('retires a recovered unsupported-media launch with a stale snapshot and admits the next text', async () => {
    const { owner, storage } = fixture();
    const media = [{ text: '', msg: { message_id: 7, chat: { id: 42 }, voice: { file_id: 'voice' } } }];
    const staleReceipt = { ...receipt, requestId: 'stale-media-request' };
    await snapshot(owner, staleReceipt, media);
    const launchKey = JSON.stringify([7]);
    await storage.put('launching', media);
    await storage.put('busy', true);
    await storage.put('busyChatId', 42);
    await storage.put('cpUnresolvedLaunches', [launchKey]);
    await storage.put(`cp-launch:${launchKey}`, { msg: { ...media[0].msg, intakeItems: media },
      snapshotRequestId: staleReceipt.requestId, profileId: 'test-profile', botUsername: 'test-bot' });
    handleMessage.mockRejectedValueOnce(Object.assign(new Error('attachments unsupported'), { code: 'INTAKE_PREPARATION_FAILED' }));

    const response = await owner.fetch(rpc('/append', { text: 'новый текст', msg: {
      message_id: 8, chat: { id: 42 }, text: 'новый текст' }, telegramUpdateId: 108 }));

    expect((await response.json()).buffered).toBe(1);
    expect(await storage.get('cpUnresolvedLaunches')).toBeUndefined();
    expect(await storage.get('launching')).toBeUndefined();
    expect(await storage.get('busy')).toBeUndefined();
    expect((await storage.get('buf')).map(item => item.text)).toEqual(['новый текст']);
  });

  it('self-recovers an orphaned unsupported-media checkpoint when the handler returns without CP admission', async () => {
    const { owner, storage } = fixture();
    const media = [{ text: '', msg: { message_id: 7, chat: { id: 42 }, voice: { file_id: 'voice' } } }];
    const launchKey = JSON.stringify([7]);
    await storage.put('busy', true);
    await storage.put('busyChatId', 42);
    // A cold restart can leave the durable launch checkpoint without the
    // transient `launching` key. Recovery must still find and retire it.
    await storage.put('cpUnresolvedLaunches', [launchKey]);
    await storage.put(`cp-launch:${launchKey}`, { msg: { ...media[0].msg, intakeItems: media },
      profileId: 'test-profile', botUsername: 'test-bot' });
    handleMessage.mockResolvedValueOnce(undefined); // pre-admission early return: no durable ACK

    const response = await owner.fetch(rpc('/append', { text: 'новый текст', msg: {
      message_id: 8, chat: { id: 42 }, text: 'новый текст' }, telegramUpdateId: 108 }));

    expect((await response.json()).buffered).toBe(1);
    expect(await storage.get('cpUnresolvedLaunches')).toBeUndefined();
    expect(await storage.get('cp-launch:' + launchKey)).toBeUndefined();
    expect(await storage.get('busy')).toBeUndefined();
    expect(await storage.get('retryBatch')).toBeUndefined();
    expect((await storage.get('buf')).map(item => item.text)).toEqual(['новый текст']);
    expect(send.mock.calls.some(call => String(call[2]).includes('порцию сбросил'))).toBe(true);
  });

  it('preserves a durably admitted launch and holds new text behind it', async () => {
    const { owner, storage } = fixture();
    const media = [{ text: '', msg: { message_id: 7, chat: { id: 42 }, voice: { file_id: 'voice' } } }];
    const launchKey = JSON.stringify([7]);
    const accepted = { ...receipt, requestId: 'accepted-media-request' };
    await snapshot(owner, accepted, media);
    await storage.put('busy', true);
    await storage.put('busyChatId', 42);
    await storage.put('launching', media);
    await storage.put('cpUnresolvedLaunches', [launchKey]);
    await storage.put('cpBusyRequests', [accepted.requestId]);
    await storage.put(`cp-launch:${launchKey}`, { msg: { ...media[0].msg, intakeItems: media },
      snapshotRequestId: accepted.requestId, profileId: 'test-profile', botUsername: 'test-bot' });
    handleMessage.mockResolvedValueOnce(undefined);

    const response = await owner.fetch(rpc('/append', { text: 'не добавлять', msg: {
      message_id: 8, chat: { id: 42 }, text: 'не добавлять' }, telegramUpdateId: 108 }));

    expect(await response.json()).toMatchObject({ buffered: 1 });
    expect(await storage.get('cpUnresolvedLaunches')).toEqual([launchKey]);
    expect(await storage.get('busy')).toBe(true);
    expect(await storage.get('cpBusyRequests')).toEqual([accepted.requestId]);
    expect(await storage.get('launching')).toEqual(media);
    expect((await storage.get('buf')).map(item => item.text)).toEqual(['не добавлять']);
    expect(send.mock.calls.some(call => String(call[2]).includes('Текст сохранил в отдельной отложенной порции'))).toBe(true);
  });

  it('holds text when a cold DO has only the durable unsupported launch checkpoint', async () => {
    const { owner, storage } = fixture();
    const media = [{ text: '', msg: { message_id: 7, chat: { id: 42 }, voice: { file_id: 'voice' } } }];
    const launchKey = JSON.stringify([7]);
    const accepted = { ...receipt, requestId: 'accepted-media-request' };
    await snapshot(owner, accepted, media);
    await storage.put('busy', true);
    await storage.put('busyChatId', 42);
    await storage.put('cpUnresolvedLaunches', [launchKey]);
    await storage.put('cpBusyRequests', [accepted.requestId]);
    await storage.put(`cp-launch:${launchKey}`, { msg: { ...media[0].msg, intakeItems: media },
      snapshotRequestId: accepted.requestId, profileId: 'test-profile', botUsername: 'test-bot' });
    // `launching` is transient and is absent after a Durable Object restart.

    const response = await owner.fetch(rpc('/append', { text: 'новый текст', msg: {
      message_id: 8, chat: { id: 42 }, text: 'новый текст' }, telegramUpdateId: 108 }));

    expect(await response.json()).toMatchObject({ buffered: 1, held: true });
    expect(await storage.get('cpUnresolvedLaunches')).toEqual([launchKey]);
    expect(await storage.get('busy')).toBe(true);
    expect(await storage.get('launching')).toBeUndefined();
    expect((await storage.get('buf')).map(item => item.text)).toEqual(['новый текст']);
    expect(send.mock.calls.some(call => String(call[2]).includes('Текст сохранил в отдельной отложенной порции'))).toBe(true);
    expect(send.mock.calls.some(call => String(call[2]).includes('Предыдущая порция ещё сверяется с запуском'))).toBe(false);
  });

  it('holds text when a busy unsupported launch remains but its unresolved index is empty', async () => {
    const { owner, storage } = fixture();
    const media = [{ text: '', msg: { message_id: 7, chat: { id: 42 }, voice: { file_id: 'voice' } } }];
    await storage.put('busy', true);
    await storage.put('busyChatId', 42);
    await storage.put('cpStopWindow', { pending: true, intentId: 'stop-window' });
    await storage.put('launching', media);

    const response = await owner.fetch(rpc('/append', { text: 'новый текст', msg: {
      message_id: 8, chat: { id: 42 }, text: 'новый текст' }, telegramUpdateId: 108 }));

    expect(await response.json()).toMatchObject({ buffered: 1, held: true });
    expect(await storage.get('busy')).toBe(true);
    expect(await storage.get('launching')).toEqual(media);
    expect(await storage.get('cpUnresolvedLaunches')).toBeUndefined();
    expect((await storage.get('buf')).map(item => item.text)).toEqual(['новый текст']);
    expect(send.mock.calls.some(call => String(call[2]).includes('Предыдущая порция ещё сверяется с запуском'))).toBe(false);
  });

  it('holds text behind a pending unsupported launch even if the busy flag was lost', async () => {
    const { owner, storage } = fixture();
    const media = [{ text: '', msg: { message_id: 7, chat: { id: 42 }, voice: { file_id: 'voice' } } }];
    await storage.put('cpStopWindow', { pending: true, intentId: 'stop-window' });
    await storage.put('launching', media);

    const response = await owner.fetch(rpc('/append', { text: 'новый текст', msg: {
      message_id: 8, chat: { id: 42 }, text: 'новый текст' }, telegramUpdateId: 108 }));

    expect(await response.json()).toMatchObject({ buffered: 1, held: true });
    expect(await storage.get('busy')).toBeUndefined();
    expect(await storage.get('launching')).toEqual(media);
    expect((await storage.get('buf')).map(item => item.text)).toEqual(['новый текст']);
    expect(await storage.get('debounceExpiresAt')).toBeUndefined();
    expect(send.mock.calls.some(call => String(call[2]).includes('Предыдущая порция ещё сверяется с запуском'))).toBe(false);
  });

  it('keeps new input as an independent draft while a stop window is pending without busy state', async () => {
    const { owner, storage } = fixture();
    await storage.put('cpStopWindow', { pending: true, intentId: 'stop-window' });
    let collectorMessageId = 80;
    const collectorSends = [];
    send.mockImplementation(async (_token, _chatId, text, keyboardOrExtra, extra) => {
      if (Array.isArray(keyboardOrExtra)) {
        const messageId = ++collectorMessageId;
        collectorSends.push({ messageId, text, keyboard: keyboardOrExtra, extra });
        return { ok: true, result: { message_id: messageId } };
      }
      return { ok: true, result: { message_id: ++collectorMessageId } };
    });

    const response = await owner.fetch(rpc('/append', { text: 'новый текст', msg: {
      message_id: 8, chat: { id: 42 }, text: 'новый текст' }, telegramUpdateId: 108 }));
    const second = await owner.fetch(rpc('/append', { text: 'ещё один текст', msg: {
      message_id: 9, chat: { id: 42 }, text: 'ещё один текст' }, telegramUpdateId: 109 }));

    expect(await response.json()).toMatchObject({ buffered: 1, held: true });
    expect(await second.json()).toMatchObject({ buffered: 2, held: true });
    expect((await storage.get('buf')).map(item => item.text)).toEqual(['новый текст', 'ещё один текст']);
    expect(await storage.get('debounceExpiresAt')).toBeUndefined();
    expect(send.mock.calls.some(call => String(call[2]).includes('Текст сохранил отдельно'))).toBe(true);
    expect(collectorSends).toHaveLength(2);
    expect(collectorSends[0].extra).toMatchObject({ reply_to_message_id: 8 });
    expect(collectorSends[1].extra).toMatchObject({ reply_to_message_id: 9 });
    expect(collectorSends[1].keyboard.flat().some(button => button.callback_data.startsWith('ws|answer|'))).toBe(true);
    expect(await storage.get('collectorMsgId')).toBe(collectorSends[1].messageId);
    expect(edit).toHaveBeenCalledWith('test-bot-token', 42, collectorSends[0].messageId,
      '↑ Сообщение выше устарело — новое ниже.', { reply_markup: { inline_keyboard: [] } });
    expect(send.mock.calls.some(call => String(call[2]).includes('Предыдущая порция ещё сверяется с запуском'))).toBe(false);
  });

  it('does not promise a launch button when Telegram collector delivery is unknown', async () => {
    const { owner, storage } = fixture();
    await storage.put('cpStopWindow', { pending: true, intentId: 'stop-window' });
    send.mockRejectedValueOnce(new Error('Telegram send timed out'));

    const first = await owner.fetch(rpc('/append', { text: 'новый текст', msg: {
      message_id: 8, chat: { id: 42 }, text: 'новый текст' }, telegramUpdateId: 108 }));

    expect(await first.json()).toMatchObject({ buffered: 1, held: true });
    expect(send.mock.calls.some(call => String(call[2]).includes('кнопки запуска не удалось показать'))).toBe(true);
    expect(send.mock.calls.some(call => String(call[2]).includes('Кнопки в сообщении выше запустят'))).toBe(false);
    expect(handleMessage).not.toHaveBeenCalled();
    expect(await storage.get('cpStopWindow')).toMatchObject({ pending: true, intentId: 'stop-window' });
    expect([...(await storage.list({ prefix: 'cp-collector-send:' })).values()]).toContainEqual({ state: 'unknown' });

    const second = await owner.fetch(rpc('/append', { text: 'ещё текст', msg: {
      message_id: 9, chat: { id: 42 }, text: 'ещё текст' }, telegramUpdateId: 109 }));

    expect(await second.json()).toMatchObject({ buffered: 2, held: true });
    expect(send.mock.calls.some(call => call[3] && Array.isArray(call[3]) && call[3].flat()
      .some(button => button.callback_data.startsWith('ws|')))).toBe(true);
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('keeps the pending barrier when unsupported media has a durable CP acceptance', async () => {
    const { owner, storage } = fixture();
    const media = [{ text: '', msg: { message_id: 7, chat: { id: 42 }, voice: { file_id: 'voice' } } }];
    await storage.put('buf', media);
    handleMessage.mockImplementationOnce(async message => {
      await snapshot(owner, receipt, message.intakeItems);
      await accept(owner, receipt);
      throw Object.assign(new Error('late preparation error'), { code: 'INTAKE_PREPARATION_FAILED' });
    });
    await owner._dispatch();
    expect(await storage.get('cpUnresolvedLaunches')).toHaveLength(1);
    expect(await storage.get('cpBusyRequests')).toEqual([receipt.requestId]);
    expect(await storage.get('launching')).toEqual(media);
  });

  it('refuses an unsupported attachment before buffering it', async () => {
    const { owner, storage } = fixture();
    const voice = { message_id: 7, chat: { id: 42 }, voice: { file_id: 'voice' } };
    const response = await owner.fetch(rpc('/append', { text: '', msg: voice, telegramUpdateId: 107 }));
    expect(await response.json()).toMatchObject({ refused: true, unsupported: 'media' });
    expect(await storage.get('buf')).toBeUndefined();
    expect(await storage.get('retryBatch')).toBeUndefined();
    expect(send.mock.calls.some(call => String(call[2]).includes('вложения пока не поддерживаются'))).toBe(true);
  });

  it('drops a stranded unsupported attachment and starts a fresh batch with the next text', async () => {
    const { owner, storage } = fixture();
    await storage.put('buf', [{ text: '', msg: { message_id: 7, chat: { id: 42 }, voice: { file_id: 'voice' } } }]);
    const response = await owner.fetch(rpc('/append', { text: 'новая текстовая задача', msg: {
      message_id: 8, chat: { id: 42 }, text: 'новая текстовая задача' }, telegramUpdateId: 108 }));
    expect((await response.json()).buffered).toBe(1);
    expect((await storage.get('buf')).map(item => item.text)).toEqual(['новая текстовая задача']);
    expect(send.mock.calls.some(call => String(call[2]).includes('Сбросил старую порцию'))).toBe(true);
  });

  it('offers an owned revision-bound discard action and refuses to discard unresolved dispatch', async () => {
    const { owner, storage, env } = fixture();
    owner.env.SESSIONS = { get: async key => key === '42' ? JSON.stringify({ username: 'test-profile' }) : null, put: async () => {} };
    await storage.put('buf', items);
    await owner._showCollector(42, 1, 1);
    const callbacks = send.mock.calls.at(-1)[3].flat().map(button => button.callback_data);
    const revision = await storage.get('draftRevision');
    expect(callbacks).toContain(`intake_discard|${revision}`);
    expect(send.mock.calls.at(-1)[3].flat().find(button => button.callback_data === `intake_discard|${revision}`).text)
      .toBe('🧹 Очистить весь ввод');
    const body = { sourceMessageId: 99, callbackData: `intake_discard|${revision}`, username: 'test-profile' };
    expect(await storage.get('collectorMsgId')).toBe(99);
    expect(await owner._callbackOwned(body)).toBe(true);
    expect(await (await owner.fetch(rpc('/callback-owner', body))).json()).toEqual({ owned: true });
    await storage.put('cpUnresolvedLaunches', ['pending-launch']);
    expect((await owner.fetch(rpc('/discard', body))).status).toBe(409);
    expect(await storage.get('buf')).toEqual(items);
    await storage.delete('cpUnresolvedLaunches');
    const uploading = [{ ...items[0], mediaPending: true }];
    await storage.put('buf', uploading);
    expect((await owner.fetch(rpc('/discard', body))).status).toBe(409);
    expect(await storage.get('buf')).toEqual(uploading);
    await storage.put('buf', items);
    await storage.put('retryBatch', items);
    await storage.put('failed:old', { id: 'old', items });
    await storage.put('media-failed:media-old', { msg: { message_id: 7 } });
    await storage.put('cpStopWindow', { pending: true, tasks: [{ userTaskId: receipt.userTaskId }] });
    expect((await owner.fetch(rpc('/discard', body))).status).toBe(200);
    expect(await storage.get('buf')).toBeUndefined();
    expect(await storage.get('retryBatch')).toBeUndefined();
    expect(await storage.get('failed:old')).toBeUndefined();
    expect(await storage.get('media-failed:media-old')).toBeUndefined();
    expect(await storage.get('cpStopWindow')).toMatchObject({ pending: true, tasks: [{ userTaskId: receipt.userTaskId }] });
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
    expect(await (await owner.fetch(rpc('/callback-owner', source))).json()).toEqual({ owned: true });
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
