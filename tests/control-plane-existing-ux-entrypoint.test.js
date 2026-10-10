import { beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { MemKV, makeEnv } from './helpers/p11-helpers.js';

vi.mock('../src/handlers/callbacks.js', () => ({ handleCallbackQuery: vi.fn() }));
vi.mock('../src/lib/telegram.js', () => ({ answerCallbackQuery: vi.fn(), sendMessage: vi.fn(), sendDocument: vi.fn(),
  sendMessageWithKeyboard: vi.fn(), editMessage: vi.fn() }));
import worker from '../src/sandbox-tg/existing-ux.js';
import { handleCallbackQuery } from '../src/handlers/callbacks.js';
import { answerCallbackQuery, sendMessage } from '../src/lib/telegram.js';
import { callbackChatId } from '../src/lib/test-mode.js';

function fixture() {
  const collectorCalls = [];
  const env = makeEnv({ SESSIONS: new MemKV(), TG_SLICE: new MemKV(), TG_SLICE_ALLOWED_USERS: '7',
    SESSION_NAMESPACE: 'isolated-ux', INTAKE_DEBOUNCE: 'on' });
  env.PRODUCTION_USERS = new MemKV();
  env.INTAKE = { idFromName: name => name, get: name => ({ async fetch(url, options) {
    collectorCalls.push({ name, url, body: JSON.parse(options.body) });
    return Response.json({ appended: true });
  } }) };
  const update = { update_id: 1, message: { message_id: 11, date: Math.floor(Date.now() / 1000),
    chat: { id: 1001, type: 'private' }, from: { id: 7 }, text: 'работает?' } };
  const send = (body = update, secret = env.TELEGRAM_WEBHOOK_SECRET) => worker.fetch(new Request('https://worker/webhook', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret }, body: JSON.stringify(body),
  }), env);
  return { env, update, send, collectorCalls };
}

function configureProbabilityOperator(env) {
  Object.assign(env, { CONTROL_PLANE_URL: 'https://trained-assist-cp-telegram-ux-v1-sandbox.skillset-apply.workers.dev',
    TG_ACCEPT_ONLY_ENVIRONMENT: 'sandbox', TG_SANDBOX_BOT_USERNAME: 'probability_cat_bot',
    TG_SANDBOX_CLEANUP_TOKEN: 'dedicated-sandbox-cleanup-token', TG_SANDBOX_TEST_API_ENABLED: 'true',
    SESSION_NAMESPACE: 'integrator-existing-ux-v1', EXECUTION_BACKEND: 'control-plane',
    TG_SLICE_OPEN_SANDBOX: 'true', TG_SLICE_INGRESS_PAUSED: 'false', TG_SLICE_DELIVERY_PAUSED: 'false' });
}

function configureSandbox3Operator(env) {
  Object.assign(env, { CONTROL_PLANE_URL: 'https://trained-assist-cp-sandbox3.skillset-apply.workers.dev',
    CONTROL_PLANE_PROFILE: 'integration-sandbox3-v1', CONTROL_PLANE_PRINCIPAL: 'integration-sandbox3-v1',
    TG_ACCEPT_ONLY_ENVIRONMENT: 'sandbox', TG_SANDBOX_BOT_USERNAME: 'ptichka_status_bot',
    TG_SANDBOX3_OPERATOR_TOKEN: 'dedicated-sandbox3-operator-token', TG_SANDBOX_TEST_API_ENABLED: 'true',
    TG_SANDBOX_E2E_CHAT_ID: '1714048', TG_SANDBOX_E2E_USER_ID: '1714048',
    SESSION_NAMESPACE: 'integrator-sandbox3-v1', EXECUTION_BACKEND: 'control-plane',
    TG_SLICE_OPEN_SANDBOX: 'false', TG_SLICE_INGRESS_PAUSED: 'false', TG_SLICE_DELIVERY_PAUSED: 'false' });
  env.TG_SLICE_DELIVERY_CUTOVER_MANIFEST = JSON.stringify({ version: 'tg-delivery-cutover-v1',
    botUsername: 'ptichka_status_bot', profileId: 'integration-sandbox3-v1', cutoverId: 'sandbox3-fixture',
    cutoverAt: Date.now(), oldTaskIds: [], deliveries: [] });
}

beforeEach(() => vi.clearAllMocks());

describe('signed existing-UX ingress', () => {
  it('keeps synthetic buffer-test sessions out of the shared sandbox KV', async () => {
    const state = fixture();
    const { env } = state;
    configureProbabilityOperator(env);
    env.TG_SANDBOX_BUFFER_TEST_CHAT_ID = '-1000000000236';
    env.SESSION_NAMESPACE = 'integrator-existing-ux-v1';
    env.INTAKE_DEBOUNCE = 'on';
    const intakeCalls = [];
    env.INTAKE = { idFromName: name => name, get: name => ({ async fetch(url, options) {
      intakeCalls.push({ name, path: new URL(url).pathname });
      if (new URL(url).pathname === '/debug') return Response.json({ buf: [{ hasText: true }, { hasText: true }], busy: false, stranded: false });
      if (new URL(url).pathname === '/append') return Response.json({ ok: true });
      if (new URL(url).pathname === '/operator/reset-all') return Response.json({ ok: true });
      return Response.json({ error: 'unexpected_intake_path' }, 404);
    } }) };

    const response = await worker.fetch(new Request('https://worker/operator/test-buffer-message', {
      method: 'POST', headers: { authorization: `Bearer ${env.TG_SANDBOX_CLEANUP_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'sandbox', text: 'sandbox-buffer-test ephemeral session', resetAfter: true }),
    }), env);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, buffer: { pendingCount: 2 }, clearedAfterRead: true });
    expect(intakeCalls.map(call => call.path)).toEqual(['/append', '/debug', '/operator/reset-all']);
    expect(env.SESSIONS.data.size).toBe(0);
  });

  it('drives an authenticated synthetic admin update through the sandbox Worker and namespaces created users', async () => {
    const { env } = fixture();
    configureProbabilityOperator(env);
    Object.assign(env, { TG_SANDBOX_BUFFER_TEST_CHAT_ID: '-1000000000236' });
    const intakeCalls = [];
    const collectorState = { buf: [], busy: false, stranded: false, collectorMsgId: null, collectorDraftRevision: null };
    env.INTAKE = { idFromName: name => name, get: name => ({ async fetch(url, options) {
      intakeCalls.push({ name, path: new URL(url).pathname });
      if (new URL(url).pathname === '/debug') return Response.json(collectorState);
      return Response.json({ ok: true, appended: true });
    } }) };
    const request = (body, token = env.TG_SANDBOX_CLEANUP_TOKEN) => worker.fetch(new Request('https://worker/operator/test-update', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    }), env);

    expect((await request({ target: 'sandbox', type: 'message', text: '/adduser e2e_worker_fixture Worker Fixture' }, 'wrong')).status).toBe(401);
    expect((await request({ target: 'sandbox', type: 'message', text: '/adduser e2e_worker_missing_chat Must Fail' })).status).toBe(409);
    expect((await request({ target: 'sandbox', type: 'message', chatId: 1001, userId: 0, text: 'bad user' })).status).toBe(400);
    expect((await request({ target: 'sandbox', type: 'message', chatId: 1001, delivery: 'log', text: 'bad delivery mode' })).status).toBe(400);
    const response = await request({ target: 'sandbox', type: 'message', chatId: 1001, userId: 7, admin: true,
      text: '/adduser e2e_worker_fixture Worker Fixture' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, chatId: 1001, userId: 7, admin: true, delivery: 'capture',
      admission: { ok: true }, collector: {
      busy: false, pendingCount: 0, stranded: false, collectorMessageId: null, launchingMessageIds: [],
    } });
    const created = JSON.parse(await env.TG_SLICE.get('user:e2e_worker_fixture'));
    expect(created.name).toBe('Worker Fixture');
    expect(created.passwordHash).toMatch(/^[a-f0-9]{64}$/);
    expect(await env.TG_SLICE.get('sandbox-user:e2e_worker_fixture')).toBeNull();
    expect(intakeCalls.map(call => call.path)).toEqual(['/debug', '/debug']);
    expect((await request({ target: 'sandbox', type: 'callback', callbackData: 'intake_run', chatId: 1001 })).status).toBe(409);
    expect(await (await request({ target: 'sandbox', type: 'callback', callbackData: 'auto',
      chatId: 1001, messageId: 89 })).json()).toMatchObject({ error: 'no_current_button_revision' });

    const unauthenticatedCallback = await request({ target: 'sandbox', type: 'callback', callbackData: 'intake_cancel',
      chatId: -1000000000236, updateId: 91009, messageId: 89 });
    expect(await unauthenticatedCallback.json()).toMatchObject({ ok: true,
      admission: { ok: true, authenticated: false } });
    expect(callbackChatId('sandbox-test-91009')).toBe(-1000000000236);

    await env.SESSIONS.put('integrator-existing-ux-v1:1001', JSON.stringify({
      username: 'e2e_worker_fixture', controlPlaneProfile: env.CONTROL_PLANE_PROFILE,
    }));
    Object.assign(collectorState, { collectorMsgId: 90, collectorDraftRevision: 4 });
    const configuredChatCallback = await request({ target: 'sandbox', type: 'callback', callbackData: 'intake_run',
      chatId: 1001, updateId: 91010, messageId: 90 });
    expect(await configuredChatCallback.json()).toMatchObject({ ok: true, chatId: 1001, callbackData: 'ws|auto|4' });
    expect(callbackChatId('sandbox-test-91010')).toBe(1001);
    expect(handleCallbackQuery).toHaveBeenLastCalledWith(expect.objectContaining({ data: 'ws|auto|4', message: expect.objectContaining({
      message_id: 90, chat: { id: 1001, type: 'private', is_forum: false },
    }) }), expect.any(Object));

    await env.SESSIONS.put('integrator-existing-ux-v1:-1000000000236', JSON.stringify({
      username: 'e2e_worker_fixture', controlPlaneProfile: env.CONTROL_PLANE_PROFILE,
    }));
    const callback = await request({ target: 'sandbox', type: 'callback', chatId: -1000000000236, callbackData: 'explore', messageId: 88 });
    expect(callback.status).toBe(200);
    expect(await callback.json()).toMatchObject({ ok: true, callbackData: 'ws|explore|4', admission: { ok: true } });
    expect(handleCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({ data: 'ws|explore|4', message: expect.objectContaining({
      message_id: 88, chat: { id: -1000000000236, type: 'supergroup', is_forum: false },
    }) }), expect.objectContaining({ TG_SLICE_ALLOWED_USERS: '7,900000236' }));
  });

  it('resets all sandbox session and intake state only after owner auth and explicit confirmation', async () => {
    const state = fixture();
    const { env } = state;
    configureProbabilityOperator(env);
    env.SESSIONS.data.set(`${env.SESSION_NAMESPACE}:42`, JSON.stringify({ username: 'old-test-user' }));
    env.SESSIONS.data.set(`${env.SESSION_NAMESPACE}:42:7`, JSON.stringify({ pendingMessage: 'old topic draft' }));
    env.SESSIONS.data.set(`${env.SESSION_NAMESPACE}:retry:42:old`, JSON.stringify({ chatId: 42 }));
    env.TG_SLICE.data.set('sandbox-user:old-user', JSON.stringify({ profileId: 'old-profile' }));
    env.TG_SLICE.data.set('user:legacy-test-user', JSON.stringify({ name: 'Old sandbox profile' }));
    env.TG_SLICE.data.set('conv:tg-old-conversation', JSON.stringify({ chatId: 42 }));
    const resetCalls = [];
    const stateKeys = new Map();
    const activeBuffers = new Set();
    const makeStub = (kind, name) => ({ async fetch(url) {
      const path = new URL(url).pathname;
      resetCalls.push(`${kind}:${path}`);
      if (!stateKeys.has(name)) stateKeys.set(name, kind === 'intake' ? 3 : 0);
      if (path.endsWith('reset-inspect')) return Response.json(kind === 'intake'
        ? { ok: true, active: activeBuffers.has(name), keys: stateKeys.get(name) } : { ok: true, keys: stateKeys.get(name) });
      if (path.endsWith('reset-all')) {
        const deletedKeys = stateKeys.get(name);
        stateKeys.set(name, 0);
        return Response.json({ ok: true, deletedKeys });
      }
      return Response.json({ ok: true });
    } });
    env.INTAKE = { idFromName: name => name, get: name => makeStub('intake', name) };
    env.SANDBOX_ACCEPT_ONLY = { idFromName: name => name, get: name => makeStub('accept-only', name) };
    const post = (body, token = env.TG_SANDBOX_CLEANUP_TOKEN) => worker.fetch(new Request('https://worker/operator/reset-sandbox-state', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    }), env);
    expect((await post({ target: 'sandbox', mode: 'inspect' }, 'wrong-token')).status).toBe(401);
    expect((await post({ target: 'production', mode: 'clear', confirm: 'CLEAR_ALL_SANDBOX_STATE' })).status).toBe(400);
    const inspect = await post({ target: 'sandbox', mode: 'inspect' });
    expect(inspect.status).toBe(200);
    expect(await inspect.json()).toMatchObject({ ok: true, sessionAndRetryKeys: 3, intakeBuffers: 2,
      sandboxUserKeys: 2, conversationIndexKeys: 1, acceptOnlyKeys: 0, active: false });
    expect(env.SESSIONS.data.size).toBe(3);
    expect(resetCalls).toHaveLength(3);
    activeBuffers.add('42');
    expect((await post({ target: 'sandbox', mode: 'inspect' })).status).toBe(200);
    const blocked = await post({ target: 'sandbox', mode: 'clear', confirm: 'CLEAR_ALL_SANDBOX_STATE' });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: 'active_intake_state', chatId: '42' });
    expect(resetCalls.some(value => value === 'intake:/operator/reset-all')).toBe(false);
    activeBuffers.delete('42');
    const cleared = await post({ target: 'sandbox', mode: 'clear', confirm: 'CLEAR_ALL_SANDBOX_STATE' });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ ok: true, sessionsAndRetryKeysDeleted: 3, sandboxUserKeysDeleted: 2,
      conversationIndexKeysDeleted: 1, intakeBuffersReset: 2 });
    expect(env.SESSIONS.data.size).toBe(0);
    expect(env.TG_SLICE.data.size).toBe(0);
    expect(resetCalls.filter(value => value === 'intake:/operator/reset-all')).toHaveLength(2);
    expect(resetCalls).toContain('accept-only:/operator/reset-all');
  });

  it('enables the Worker test API only for the pinned sandbox3 identity, CP, and user', async () => {
    const { env } = fixture();
    configureSandbox3Operator(env);
    const intakeCalls = [];
    env.INTAKE = { idFromName: name => name, get: name => ({ async fetch(url, options) {
      intakeCalls.push({ name, path: new URL(url).pathname, body: options?.body ? JSON.parse(options.body) : null });
      return Response.json({ buf: [], retryBatch: [], busy: false, launching: [] });
    } }) };
    const request = (body, token = env.TG_SANDBOX3_OPERATOR_TOKEN) => worker.fetch(new Request('https://worker/operator/test-update', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }), env);

    expect((await request({ target: 'sandbox', type: 'message', chatId: 1714048, userId: 1714048, text: '/help' })).status).toBe(400);
    expect((await request({ target: 'sandbox3', type: 'message', chatId: 1714048, userId: 1714048, text: '/help' },
      'dedicated-sandbox-cleanup-token')).status).toBe(401);
    expect((await request({ target: 'sandbox3', type: 'message', chatId: 1714049, userId: 1714048, text: '/help' })).status).toBe(403);
    expect((await request({ target: 'sandbox3', type: 'message', chatId: 1714048, userId: 1714049, text: '/help' })).status).toBe(403);
    const response = await request({ target: 'sandbox3', type: 'message', chatId: 1714048, userId: 1714048,
      delivery: 'capture', text: '/help' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, chatId: 1714048, userId: 1714048, delivery: 'capture',
      admission: { ok: true } });
    expect(intakeCalls.map(call => call.path)).toEqual(['/debug', '/debug']);

    env.CONTROL_PLANE_URL = 'https://trained-assist-cp-telegram-ux-v1-sandbox.skillset-apply.workers.dev';
    env.TG_SANDBOX_CLEANUP_TOKEN = 'dedicated-sandbox-cleanup-token';
    expect((await request({ target: 'sandbox3', type: 'message', chatId: 1714048, userId: 1714048, text: '/help' },
      'dedicated-sandbox-cleanup-token')).status).toBe(409);
  });

  it('includes the pinned sandbox3 E2E chat in guarded reset even when no KV session remains', async () => {
    const { env } = fixture();
    configureSandbox3Operator(env);
    env.SESSIONS.data.clear();
    env.TG_SLICE.data.clear();
    const inspectedNames = [];
    env.INTAKE = { idFromName: name => name, get: name => ({ async fetch(url) {
      const path = new URL(url).pathname;
      if (path === '/operator/reset-inspect') inspectedNames.push(name);
      if (path === '/operator/reset-inspect') return Response.json({ ok: true, active: false, keys: 0 });
      if (path === '/operator/reset-all') return Response.json({ ok: true, deletedKeys: 0 });
      return Response.json({ ok: true, keys: 0 });
    } }) };
    const legacyCalls = [];
    let legacyKeys = 2;
    env.LEGACY_INTAKE = { idFromName: name => name, get: name => ({ async fetch(url) {
      legacyCalls.push({ name, path: new URL(url).pathname });
      if (new URL(url).pathname === '/operator/reset-inspect') return Response.json({ ok: true, active: false, keys: legacyKeys });
      if (new URL(url).pathname === '/operator/reset-all') {
        const deletedKeys = legacyKeys;
        legacyKeys = 0;
        return Response.json({ ok: true, deletedKeys });
      }
      return Response.json({ ok: true, keys: legacyKeys });
    } }) };
    env.SANDBOX_ACCEPT_ONLY = { idFromName: name => name, get: () => ({ async fetch(url) {
      if (new URL(url).pathname === '/operator/reset-inspect') return Response.json({ ok: true, keys: 0 });
      return Response.json({ ok: true });
    } }) };
    const response = await worker.fetch(new Request('https://worker/operator/reset-sandbox-state', {
      method: 'POST', headers: { authorization: `Bearer ${env.TG_SANDBOX3_OPERATOR_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'sandbox3', mode: 'inspect' }),
    }), env);
    expect(response.status).toBe(200);
    expect(inspectedNames).toEqual(['1714048']);
    expect(legacyCalls.map(call => call.path)).toEqual(['/operator/reset-inspect']);
    expect(await response.json()).toMatchObject({ ok: true, target: 'sandbox3', active: false, intakeNamespaces: ['intake', 'legacyIntake'] });
    const cleared = await worker.fetch(new Request('https://worker/operator/reset-sandbox-state', {
      method: 'POST', headers: { authorization: `Bearer ${env.TG_SANDBOX3_OPERATOR_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'sandbox3', mode: 'clear', confirm: 'CLEAR_ALL_SANDBOX_STATE' }),
    }), env);
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ ok: true, target: 'sandbox3', intakeBuffersReset: 1,
      intakeNamespacesReset: ['intake', 'legacyIntake'] });
    expect(legacyCalls.map(call => call.path)).toEqual(['/operator/reset-inspect', '/operator/reset-inspect', '/operator/reset-all', '/operator/reset-inspect']);
  });

  it('reads only delivery metadata for the pinned sandbox3 chat', async () => {
    const { env } = fixture();
    configureSandbox3Operator(env);
    const calls = [];
    env.TG_DELIVERY_OWNER = { idFromName: name => name, get: () => ({ async fetch(request) {
      const body = await request.json();
      calls.push({ path: new URL(request.url).pathname, body });
      return Response.json({ receipt: null, terminal: { deliveryId: 'terminal:task-1:g1', userTaskId: body.taskId,
        status: 'sent', attempts: 1, providerMessageId: 123, generation: 1, chatId: 1714048, threadId: null } });
    } }) };
    const response = await worker.fetch(new Request('https://worker/operator/test-delivery/task-1', {
      headers: { authorization: `Bearer ${env.TG_SANDBOX3_OPERATOR_TOKEN}` },
    }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ taskId: 'task-1', terminal: { status: 'sent', chatId: 1714048,
      providerMessageId: 123 } });
    expect(calls).toEqual([{ path: '/read', body: { taskId: 'task-1' } }]);
    env.TG_DELIVERY_OWNER.get = () => ({ fetch: async () => Response.json({ receipt: null, terminal: {
      status: 'sent', chatId: -1001234567890,
    } }) });
    const foreign = await worker.fetch(new Request('https://worker/operator/test-delivery/task-1', {
      headers: { authorization: `Bearer ${env.TG_SANDBOX3_OPERATOR_TOKEN}` },
    }), env);
    expect(foreign.status).toBe(409);
    expect(await foreign.json()).toMatchObject({ error: 'sandbox_test_delivery_identity_mismatch' });
  });

  it('protects delivery-owner readiness and reads it without reconciling deliveries', async () => {
    const state = fixture();
    expect((await worker.fetch(new Request('https://worker/delivery-cutover'), state.env)).status).toBe(401);
    const response = await worker.fetch(new Request('https://worker/delivery-cutover', {
      headers: { 'x-telegram-bot-api-secret-token': state.env.TELEGRAM_WEBHOOK_SECRET },
    }), state.env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ready: true });
    expect(state.collectorCalls).toEqual([]);
    expect(handleCallbackQuery).not.toHaveBeenCalled();
  });

  it('uses a dedicated operator token for cutover reads without relying on the Telegram webhook secret', async () => {
    const state = fixture();
    configureProbabilityOperator(state.env);
    state.env.TG_SANDBOX_CUTOVER_READ_TOKEN = 'dedicated-cutover-read-token';
    expect((await worker.fetch(new Request('https://worker/operator/delivery-cutover', {
      headers: { authorization: `Bearer ${state.env.TELEGRAM_WEBHOOK_SECRET}` },
    }), state.env)).status).toBe(401);
    const response = await worker.fetch(new Request('https://worker/operator/delivery-cutover', {
      headers: { authorization: `Bearer ${state.env.TG_SANDBOX_CUTOVER_READ_TOKEN}` },
    }), state.env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ready: true });
    expect(state.collectorCalls).toEqual([]);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('keeps a read-only V1 operator path available while V2 is deployed but unprovisioned', async () => {
    const state = fixture();
    configureProbabilityOperator(state.env);
    state.env.TG_SANDBOX_CUTOVER_READ_TOKEN = 'dedicated-cutover-read-token';
    state.env.TG_SLICE_INGRESS_PAUSED = 'true';
    state.env.TG_DELIVERY_OWNER_V2 = { idFromName: name => name, get: () => ({ fetch: async () => {
      throw new Error('V2 manifest is not provisioned');
    } }) };
    const response = await worker.fetch(new Request('https://worker/operator/delivery-cutover-v1', {
      headers: { authorization: `Bearer ${state.env.TG_SANDBOX_CUTOVER_READ_TOKEN}` },
    }), state.env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ready: true, paused: false, ingressPaused: true });
    expect(state.collectorCalls).toEqual([]);
  });

  it('rejects authenticated sandbox ingress while the cutover inventory is being replaced', async () => {
    const state = fixture();
    state.env.TG_SLICE_INGRESS_PAUSED = 'true';
    const response = await state.send();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'sandbox ingress paused' });
    expect(state.collectorCalls).toEqual([]);
    expect(handleCallbackQuery).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('prefers the independent V2 durable owner and its separate immutable manifest', async () => {
    const state = fixture();
    configureProbabilityOperator(state.env);
    state.env.TG_SANDBOX_CUTOVER_READ_TOKEN = 'dedicated-cutover-read-token';
    state.env.TG_SLICE_DELIVERY_CUTOVER_MANIFEST_V2 = JSON.stringify({
      version: 'tg-delivery-cutover-v1', botUsername: 'probability_cat_bot', profileId: 'profile-1',
      cutoverId: 'existing-ux-v2-fixture', cutoverAt: Date.now(), oldTaskIds: ['ut-legacy'],
      deliveries: [{ deliveryId: 'ut-legacy', userTaskId: 'ut-legacy', destination: { chatId: 1001, threadId: null },
        priorStatus: 'sent', providerMessageId: 123, attempts: 1 }],
    });
    let v1Calls = 0;
    let v2Calls = 0;
    state.env.TG_DELIVERY_OWNER = { idFromName: name => name, get: () => ({ fetch: async () => {
      v1Calls += 1;
      return Response.json({ ready: false }, { status: 503 });
    } }) };
    state.env.TG_DELIVERY_OWNER_V2 = { idFromName: name => name, get: () => ({ fetch: async () => {
      v2Calls += 1;
      return Response.json({ ready: true, cutoverId: 'existing-ux-v2-fixture', manifestDigest: 'a'.repeat(64),
        cutoverAt: Date.now(), quarantinedTaskCount: 1, quarantinedDeliveryCount: 1, paused: true });
    } }) };
    const response = await worker.fetch(new Request('https://worker/operator/delivery-cutover', {
      headers: { authorization: `Bearer ${state.env.TG_SANDBOX_CUTOVER_READ_TOKEN}` },
    }), state.env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ cutoverId: 'existing-ux-v2-fixture', quarantinedTaskCount: 1 });
    expect(v2Calls).toBe(1);
    expect(v1Calls).toBe(0);
  });

  it('protects operator reconciliation and reuses the scheduled controller', async () => {
    const state = fixture();
    expect((await worker.fetch(new Request('https://worker/cron'), state.env)).status).toBe(401);
    const response = await worker.fetch(new Request('https://worker/cron', {
      headers: { 'x-telegram-bot-api-secret-token': state.env.TELEGRAM_WEBHOOK_SECRET },
    }), state.env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ reconciled: true, pushed: [] });
    expect(state.collectorCalls).toEqual([]);
  });

  it('refuses unsigned or foreign collector-state reads', async () => {
    const state = fixture();
    expect((await worker.fetch(new Request('https://worker/collector-state?chatId=1001'), state.env)).status).toBe(401);
    expect((await worker.fetch(new Request('https://worker/collector-state?chatId=9999', {
      headers: { 'x-telegram-bot-api-secret-token': state.env.TELEGRAM_WEBHOOK_SECRET },
    }), state.env)).status).toBe(403);
    expect(state.collectorCalls).toEqual([]);
  });

  it('requires the profile login before accepting ordinary input', async () => {
    const state = fixture();
    const refused = await state.send();
    expect(refused.status).toBe(200);
    expect(await refused.json()).toMatchObject({ ok: true, authenticated: false });
    expect(state.collectorCalls).toEqual([]);
    expect(await state.env.SESSIONS.get('isolated-ux:1001')).toBeNull();
    expect(sendMessage).toHaveBeenCalledWith(state.env.TG_SANDBOX_BOT_TOKEN, 1001,
      expect.stringContaining('/login username password'));
    expect(handleCallbackQuery).not.toHaveBeenCalled();
  });

  it('answers /help and /status immediately without appending either command to Intake', async () => {
    const state = fixture();
    const { env } = state;
    env.SESSIONS.data.set('isolated-ux:1001', JSON.stringify({ username: 'fixture-user', controlPlaneProfile: env.CONTROL_PLANE_PROFILE }));
    const statusCalls = [];
    env.INTAKE = { idFromName: name => name, get: name => ({ async fetch(url) {
      statusCalls.push({ name, path: new URL(url).pathname });
      return Response.json({ buf: [{ hasText: true }], retryBatch: [], busy: false, launching: [],
        controlPlaneBarrier: { busyRequestCount: 0, unresolvedLaunchCount: 0 } });
    } }) };
    const help = await state.send({ ...state.update, message: { ...state.update.message, text: '/help' } });
    expect(await help.json()).toMatchObject({ ok: true, serviceCommand: 'help' });
    expect(sendMessage).toHaveBeenLastCalledWith(env.TG_SANDBOX_BOT_TOKEN, 1001,
      'Команды: /help, /status. Сообщение с вопросом отправь обычным текстом.', {});
    const status = await state.send({ ...state.update, update_id: 2,
      message: { ...state.update.message, message_id: 12, text: '/status' } });
    expect(await status.json()).toMatchObject({ ok: true, serviceCommand: 'status', active: false, pending: 1 });
    expect(sendMessage).toHaveBeenLastCalledWith(env.TG_SANDBOX_BOT_TOKEN, 1001,
      'Собран ввод: 1 сообщение.', {});
    expect(statusCalls).toEqual([{ name: '1001', path: '/debug' }]);
    expect(state.collectorCalls).toEqual([]);
    expect(handleCallbackQuery).not.toHaveBeenCalled();
  });

  it('runs two-question registration through the signed sandbox Telegram update handler and returns the Skip button transcript', async () => {
    const state = fixture();
    state.env.TG_SLICE_OPEN_SANDBOX = 'true';
    state.env.TG_ACCEPT_ONLY_ENVIRONMENT = 'sandbox';
    state.env.TG_HTTP_TEST_MODE = 'true';
    const cpUpdates = [];
    const steps = [
      { step: 'activity', message: 'Чем вы занимаетесь? Расскажите в паре предложений.' },
      { step: 'social_url', message: 'Пришлите ссылку на соцсеть. Мы её не проверяем.' },
      { step: 'profile_name', message: 'Как назвать профиль? /skip', profileId: undefined },
      { step: 'complete', message: 'Профиль создан. Доступно 100000000 токенов.', profileId: 'prof-12345678-1234-4234-8234-123456789abc' },
    ];
    state.env.CONTROL_PLANE_SERVICE = { async fetch(url, init) {
      cpUpdates.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) });
      return Response.json(steps[cpUpdates.length - 1], { status: cpUpdates.length === 4 ? 200 : 202 });
    } };
    const sendText = (update_id, text) => state.send({ update_id, message: { ...state.update.message, message_id: update_id + 10, text } });
    expect((await (await sendText(10, '/start')).json()).registration.step).toBe('activity');
    expect((await (await sendText(11, 'I build web products and help small companies improve their analytics.')).json()).registration.step).toBe('social_url');
    const optional = await (await sendText(12, 'https://example.org/profile')).json();
    expect(optional).toMatchObject({ buttons: [{ text: 'Пропустить', callbackData: 'registration_skip' }] });
    const skipped = await state.send({ update_id: 13, callback_query: { id: 'skip-1', data: 'registration_skip',
      from: { id: 7 }, message: { ...state.update.message, message_id: 23, text: null } } });
    expect(await skipped.json()).toMatchObject({ registration: { step: 'complete', profileId: 'prof-12345678-1234-4234-8234-123456789abc' } });
    expect(cpUpdates).toHaveLength(4);
    expect(cpUpdates.map(item => item.body.update.update_id)).toEqual([10, 11, 12, 13]);
    expect(cpUpdates.every(item => item.headers.get('x-principal') === state.env.CONTROL_PLANE_PRINCIPAL)).toBe(true);
    expect(state.collectorCalls).toEqual([]);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(JSON.parse(await state.env.SESSIONS.get('isolated-ux:1001'))).toMatchObject({
      telegramUserId: '7', controlPlaneProfile: 'prof-12345678-1234-4234-8234-123456789abc', registrationStep: 'complete',
    });
    const task = await state.send({ update_id: 14, message: { ...state.update.message, message_id: 24, text: 'Please research this topic' } });
    expect(task.status).toBe(503);
    expect(await task.json()).toMatchObject({ code: 'PROFILE_EXECUTION_NOT_ENABLED' });
    expect(state.collectorCalls).toEqual([]);
  });

  it('explains profile lookup after an unknown slash command without starting intake', async () => {
    const state = fixture();
    const update = { ...state.update, update_id: 4,
      message: { ...state.update.message, text: '/listuser' } };
    const response = await state.send(update);
    expect(await response.json()).toMatchObject({ ok: true, authenticated: false, unknownCommand: true });
    expect(sendMessage).toHaveBeenCalledWith(state.env.TG_SANDBOX_BOT_TOKEN, 1001,
      expect.stringContaining('/listusers'));
    expect(sendMessage).toHaveBeenCalledWith(state.env.TG_SANDBOX_BOT_TOKEN, 1001,
      expect.stringContaining('/pass_reset username'));
    expect(state.collectorCalls).toEqual([]);
  });

  it('logs a profile into this chat and then accepts input under that username', async () => {
    const state = fixture();
    const password = 'fixture-pass';
    const salt = new Uint8Array(16).fill(9);
    const key = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await webcrypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256);
    const saltHex = [...salt].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const passwordHash = [...new Uint8Array(bits)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    await state.env.TG_SLICE.put('user:owner', JSON.stringify({ name: 'Profile Owner', salt: saltHex, passwordHash }));
    const login = await state.send({ ...state.update, update_id: 2,
      message: { ...state.update.message, message_id: 12, text: `/login owner ${password}` } });
    expect(login.status).toBe(200);
    expect(await login.json()).toMatchObject({ ok: true, authenticated: true });
    expect(JSON.parse(await state.env.SESSIONS.get('isolated-ux:1001'))).toMatchObject({
      username: 'owner', name: 'Profile Owner', controlPlaneProfile: 'profile-1',
    });
    const inputUpdate = { ...state.update, update_id: 3,
      message: { ...state.update.message, message_id: 13, text: 'работает?' } };
    expect((await state.send(inputUpdate)).status).toBe(200);
    expect(state.collectorCalls).toEqual([{ name: '1001', url: 'https://intake/append',
      body: { text: 'работает?', msg: inputUpdate.message, flush: false, telegramUpdateId: 3 } }]);
    expect(handleCallbackQuery).not.toHaveBeenCalled();
    expect(await state.env.SESSIONS.get('1001')).toBeNull();
    expect(JSON.parse(await state.env.SESSIONS.get('isolated-ux:1001')).controlPlaneProfile).toBe('profile-1');
  });

  it('logs in with an admin-created profile and keeps sandbox password reset local', async () => {
    const state = fixture();
    const password = 'production-profile-pass';
    const salt = new Uint8Array(16).fill(12);
    const key = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await webcrypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256);
    const saltHex = [...salt].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const passwordHash = [...new Uint8Array(bits)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const productionUser = { name: 'Profile Owner', salt: saltHex, passwordHash };
    await state.env.PRODUCTION_USERS.put('user:owner', JSON.stringify(productionUser));

    const login = await state.send({ ...state.update, update_id: 2,
      message: { ...state.update.message, message_id: 12, text: `/login owner ${password}` } });
    expect(await login.json()).toMatchObject({ authenticated: true });

    const resetState = fixture();
    await resetState.env.PRODUCTION_USERS.put('user:owner', JSON.stringify(productionUser));
    const reset = await resetState.send({ ...resetState.update, update_id: 2,
      message: { ...resetState.update.message, message_id: 12, text: '/pass_reset owner' } });
    expect(await reset.json()).toMatchObject({ ok: true });
    const resetMessage = sendMessage.mock.calls.at(-1)[2];
    const sandboxPassword = /Пароль: <code>([^<]+)<\/code>/.exec(resetMessage)?.[1];
    expect(sandboxPassword).toBeTruthy();
    expect(resetMessage).toContain(`/login owner ${sandboxPassword}`);
    expect(JSON.parse(await resetState.env.PRODUCTION_USERS.get('user:owner'))).toEqual(productionUser);
    expect(JSON.parse(await resetState.env.TG_SLICE.get('user:owner')).passwordHash).not.toBe(passwordHash);

    const secondChat = { ...resetState.update, update_id: 3,
      message: { ...resetState.update.message, message_id: 13, chat: { id: 1002, type: 'private' },
        text: `/login owner ${sandboxPassword}` } };
    expect(await (await resetState.send(secondChat)).json()).toMatchObject({ authenticated: true });
    expect(JSON.parse(await resetState.env.SESSIONS.get('isolated-ux:1002'))).toMatchObject({
      username: 'owner', controlPlaneProfile: 'profile-1',
    });
  });

  it('refuses unsigned ingress before collector and session mutations', async () => {
    const state = fixture();
    expect((await state.send(state.update, 'wrong')).status).toBe(401);
    expect(state.collectorCalls).toEqual([]);
    expect(state.env.SESSIONS.data.size).toBe(0);
  });

  it('refuses foreign callback users even in the allowed chat', async () => {
    const state = fixture();
    const update = { update_id: 2, callback_query: { id: 'foreign', data: 'intake_run', from: { id: 8 }, message: state.update.message } };
    expect((await state.send(update)).status).toBe(403);
    expect(handleCallbackQuery).not.toHaveBeenCalled();
    expect(state.collectorCalls).toEqual([]);
  });

  it('does not send unsupported legacy callbacks to legacy execution', async () => {
    const state = fixture();
    await state.env.SESSIONS.put('isolated-ux:1001', JSON.stringify({ username: 'test-profile', controlPlaneProfile: 'profile-1' }));
    const update = { update_id: 2, callback_query: { id: 'owned', data: 'sp:old-session', from: { id: 7 }, message: state.update.message } };
    const response = await state.send(update);
    expect(await response.json()).toMatchObject({ ok: true, unsupported: true });
    expect(handleCallbackQuery).not.toHaveBeenCalled();
    expect(answerCallbackQuery).toHaveBeenCalledWith(state.env.TG_SANDBOX_BOT_TOKEN, 'owned', expect.stringContaining('ещё не подключена'));
  });

  it('does not expose native stop before exit provenance is accepted', async () => {
    const state = fixture();
    await state.env.SESSIONS.put('isolated-ux:1001', JSON.stringify({ username: 'test-profile', controlPlaneProfile: 'profile-1' }));
    const update = { update_id: 2, callback_query: { id: 'owned', data: 'intake_stopyes|supp', from: { id: 7 }, message: state.update.message } };
    const response = await state.send(update);
    expect(await response.json()).toMatchObject({ ok: true, unsupported: true });
    expect(handleCallbackQuery).not.toHaveBeenCalled();
    expect(state.collectorCalls).toEqual([]);
  });

  it('refuses a changed trusted profile without reusing the existing session', async () => {
    const state = fixture();
    await state.env.SESSIONS.put('isolated-ux:1001', JSON.stringify({ username: 'integrator', controlPlaneProfile: 'other-profile' }));
    expect((await state.send()).status).toBe(403);
    expect(state.collectorCalls).toEqual([]);
  });
});
