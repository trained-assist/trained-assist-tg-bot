import { Hono } from 'hono';
import { chatAllowed, readTgSliceConfig } from './config.js';
import { createController } from './index.js';
import { IntakeBuffer } from '../intake-buffer.js';
import { TgDeliveryOwner, TgDeliveryOwnerV2 } from './delivery-owner.js';
import { handleCallbackQuery } from '../handlers/callbacks.js';
import { getSession, setSession, deleteSession } from '../lib/kv.js';
import { applySessionNamespace } from '../lib/session-namespace.js';
import { conversationKey, threadIdOf, threadExtra } from '../conversation-context.js';
import { FORCE_RUN_RE, AUTO_LAUNCH_RE, hasIntakeContent } from '../intake-routing.js';
import { beginTestCapture, initTestMode, rememberCallback } from '../lib/test-mode.js';
import { answerCallbackQuery, sendMessage, sendMessageWithKeyboard } from '../lib/telegram.js';
import { ControlPlaneClient } from './control-plane-client.js';
import { cmdLogin } from '../handlers/commands.js';
import { handleUserMgmt, isUserMgmtCommand } from '../handlers/user-mgmt.js';
import acceptOnlyWorker, { SandboxAcceptOnlyStore } from './accept-only.js';
import { sandboxOperatorChatAllowed, sandboxOperatorLane, sandboxOperatorResetChat, sandboxOperatorToken, sandboxOperatorUserAllowed } from './operator-lane.js';

const app = new Hono();

app.all('/sandbox/accept-only/*', c => acceptOnlyWorker.fetch(c.req.raw, c.env));

function executionEnv(env) {
  return applySessionNamespace({ ...env, EXECUTION_BACKEND: 'control-plane',
    BOT_TOKEN: env.TG_SANDBOX_BOT_TOKEN, BOT_USERNAME: env.TG_SANDBOX_BOT_USERNAME,
    USERS: env.USERS ?? env.TG_SLICE, LOGIN_USERS: env.PRODUCTION_USERS,
    CONTROL_PLANE_PROFILE: env.CONTROL_PLANE_PROFILE });
}

function createEphemeralSessionStore() {
  const values = new Map();
  return {
    async get(key) { return values.get(key) ?? null; },
    async put(key, value) { values.set(key, value); },
    async delete(key) { values.delete(key); },
    async list({ prefix = '' } = {}) {
      return { keys: [...values.keys()].filter(name => name.startsWith(prefix)).map(name => ({ name })), list_complete: true };
    },
  };
}

app.get('/health', context => context.json({ status: 'ok', mode: 'existing-ux-control-plane', acceptance: 'pending' }));

app.get('/cron', async context => {
  const config = readTgSliceConfig(context.env);
  if (!config.webhookSecret || context.req.header('x-telegram-bot-api-secret-token') !== config.webhookSecret) return context.json({ error: 'unauthorized' }, 401);
  const controller = createController(context.env, config);
  await controller.outbox.open();
  return context.json({ reconciled: true, ...await controller.reconcile() });
});

app.get('/delivery-cutover', async context => {
  const config = readTgSliceConfig(context.env);
  if (!config.webhookSecret || context.req.header('x-telegram-bot-api-secret-token') !== config.webhookSecret) return context.json({ error: 'unauthorized' }, 401);
  try {
    return context.json(await createController(context.env, config).outbox.open());
  } catch {
    return context.json({ error: 'delivery owner refused' }, 503);
  }
});

app.get('/operator/delivery-cutover', async context => {
  const env = executionEnv(context.env);
  const target = sandboxOperatorLane(env);
  const token = target === 'sandbox3'
    ? sandboxOperatorToken(env, target)
    : String(env.TG_SANDBOX_CUTOVER_READ_TOKEN ?? '').trim();
  if (!token || context.req.header('authorization') !== `Bearer ${token}`) return context.json({ error: 'unauthorized' }, 401);
  if (!target || env.TG_SANDBOX_TEST_API_ENABLED !== 'true') return context.json({ error: 'sandbox_identity_mismatch' }, 409);
  try {
    const config = readTgSliceConfig(env);
    return context.json(await createController(env, config).outbox.open());
  } catch {
    return context.json({ error: 'delivery owner refused' }, 503);
  }
});

// During V2 provisioning, read the immutable V1 owner explicitly. The normal
// operator route follows the active V2 binding and cannot serve as a V1
// preflight after that binding is deployed without its manifest yet.
app.get('/operator/delivery-cutover-v1', async context => {
  const env = executionEnv(context.env);
  const target = sandboxOperatorLane(env);
  const token = target === 'sandbox3'
    ? sandboxOperatorToken(env, target)
    : String(env.TG_SANDBOX_CUTOVER_READ_TOKEN ?? '').trim();
  if (!token || context.req.header('authorization') !== `Bearer ${token}`) return context.json({ error: 'unauthorized' }, 401);
  if (!target || env.TG_SANDBOX_TEST_API_ENABLED !== 'true') return context.json({ error: 'sandbox_identity_mismatch' }, 409);
  try {
    const config = readTgSliceConfig(env);
    const v1Env = { ...env, TG_DELIVERY_OWNER_V2: undefined,
      TG_SLICE_DELIVERY_CUTOVER_MANIFEST_V2: undefined };
    return context.json(await createController(v1Env, config).outbox.open());
  } catch {
    return context.json({ error: 'delivery owner refused' }, 503);
  }
});

// Bounded E2E observation for the pinned sandbox identity. This performs a
// read only from the delivery owner and never returns message text.
app.get('/operator/test-delivery/:taskId', async context => {
  const env = executionEnv(context.env);
  const target = sandboxOperatorLane(env);
  const token = sandboxOperatorToken(env, target);
  if (!token || context.req.header('authorization') !== `Bearer ${token}`) return context.json({ error: 'unauthorized' }, 401);
  if (target !== 'sandbox3' || env.TG_SANDBOX_TEST_API_ENABLED !== 'true'
      || !sandboxOperatorResetChat(env, target)) return context.json({ error: 'sandbox_identity_mismatch' }, 409);
  const taskId = context.req.param('taskId');
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(taskId)) return context.json({ error: 'invalid_task_id' }, 400);
  try {
    const config = readTgSliceConfig(env);
    const result = await createController(env, config).outbox.read(taskId);
    const records = [result.receipt, result.terminal].filter(Boolean);
    if (records.some(record => String(record.chatId) !== String(env.TG_SANDBOX_E2E_CHAT_ID ?? '')))
      return context.json({ error: 'sandbox_test_delivery_identity_mismatch' }, 409);
    return context.json({ taskId, receipt: result.receipt, terminal: result.terminal });
  } catch {
    return context.json({ error: 'sandbox_test_delivery_unavailable' }, 503);
  }
});

app.get('/collector-state', async context => {
  const env = executionEnv(context.env);
  const config = readTgSliceConfig(env);
  if (!config.webhookSecret || context.req.header('x-telegram-bot-api-secret-token') !== config.webhookSecret) return context.json({ error: 'unauthorized' }, 401);
  const chatId = context.req.query('chatId');
  if (!config.allowedChats.includes(chatId)) return context.json({ error: 'owner refused' }, 403);
  const rawThread = context.req.query('threadId');
  const threadId = rawThread == null ? null : Number(rawThread);
  if (threadId != null && (!Number.isSafeInteger(threadId) || threadId <= 0)) return context.json({ error: 'invalid topic' }, 400);
  const stub = env.INTAKE.get(env.INTAKE.idFromName(conversationKey(chatId, threadId)));
  const response = await stub.fetch('https://intake/debug');
  return new Response(response.body, { status: response.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
});

// Owner-only recovery for the isolated probability sandbox. The dedicated
// token is independent of Telegram's webhook secret; no corresponding route is
// mounted by the production Worker.
app.post('/operator/stop-window', async context => {
  const env = executionEnv(context.env);
  const config = readTgSliceConfig(env);
  const token = String(env.TG_SANDBOX_OPERATOR_TOKEN ?? '').trim();
  if (!token || context.req.header('authorization') !== `Bearer ${token}`) return context.json({ error: 'unauthorized' }, 401);
  const source = await context.req.json().catch(() => null);
  const chatId = source?.chatId ?? (config.allowedChats.length === 1 ? Number(config.allowedChats[0]) : null);
  const profileId = source?.profileId ?? config.profileId;
  if (!source || !['inspect', 'release', 'abandon'].includes(source.mode) || !Number.isSafeInteger(chatId) ||
      (source.threadId != null && (!Number.isSafeInteger(source.threadId) || source.threadId <= 0)) ||
      profileId !== config.profileId ||
      (source.windowId != null && typeof source.windowId !== 'string') ||
      (source.mode !== 'inspect' && typeof source.windowId !== 'string') ||
      source.mode === 'abandon' && (source.confirmWindowId !== source.windowId ||
        source.auditReason !== 'sandbox_test_fixture_abandoned')) return context.json({ error: 'invalid selector' }, 400);
  if (!config.allowedChats.includes(String(chatId))) return context.json({ error: 'owner refused' }, 403);
  if (env.TG_SANDBOX_OPERATOR_RECOVERY !== 'enabled') return context.json({ error: 'recovery disabled' }, 404);
  const selector = { ...source, chatId, profileId, threadId: source.threadId ?? null };
  const stub = env.INTAKE.get(env.INTAKE.idFromName(conversationKey(chatId, selector.threadId)));
  const response = await stub.fetch('https://intake/operator/stop-window', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(selector),
  });
  return new Response(response.body, { status: response.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
});

// Full reset for this dedicated sandbox lane. This is intentionally unavailable
// in the production Worker: it removes every namespaced session/retry key and
// every Intake DO reached from those chat/topic keys, regardless of stale profile
// mappings. The caller must preflight and clear the paired CP sandbox as well.
app.post('/operator/reset-sandbox-state', async context => {
  const env = executionEnv(context.env);
  const target = sandboxOperatorLane(env);
  const token = sandboxOperatorToken(env, target);
  if (!token || context.req.header('authorization') !== `Bearer ${token}`) return context.json({ error: 'unauthorized' }, 401);
  if (!target || env.TG_SANDBOX_TEST_API_ENABLED !== 'true' ||
      !env.SESSIONS || !env.INTAKE || !env.TG_SLICE) return context.json({ error: 'sandbox_identity_mismatch' }, 409);
  const body = await context.req.json().catch(() => null);
  if (!body || body.target !== target || !['inspect', 'clear'].includes(body.mode) ||
      (body.mode === 'clear' && body.confirm !== 'CLEAR_ALL_SANDBOX_STATE') ||
      Object.keys(body).some(key => !['target', 'mode', 'confirm'].includes(key))) return context.json({ error: 'explicit_sandbox_confirmation_required' }, 400);
  const lockKey = `sandbox-state-reset:${env.SESSION_NAMESPACE}`;
  if (body.mode === 'clear') {
    if (await env.TG_SLICE.get(lockKey)) return context.json({ error: 'reset_already_in_progress' }, 409);
    await env.TG_SLICE.put(lockKey, String(Date.now()), { expirationTtl: 900 });
  } else if (await env.TG_SLICE.get(lockKey)) return context.json({ error: 'reset_in_progress' }, 409);

  try {
  const chatIds = new Set();
  const threadKeys = new Map();
  let cursor;
  do {
    const page = await env.SESSIONS.list({ ...(cursor ? { cursor } : {}) });
    for (const item of page.keys) {
      const key = item.name;
      const raw = key.slice(`${env.SESSION_NAMESPACE}:`.length);
      const topic = /^(-?\d+):([1-9]\d*)$/.exec(raw);
      const chat = /^-?\d+$/.exec(raw);
      const retry = /^retry:(-?\d+):/.exec(raw);
      const sent = /^sent:(-?\d+)$/.exec(raw);
      if (topic) {
        chatIds.add(topic[1]);
        const selector = { chatId: topic[1], threadId: Number(topic[2]) };
        threadKeys.set(conversationKey(selector.chatId, selector.threadId), selector);
      } else if (chat) chatIds.add(raw);
      else if (retry) chatIds.add(retry[1]);
      else if (sent) chatIds.add(sent[1]);
    }
    cursor = page.list_complete === false ? page.cursor : null;
    if (cursor && cursor === page.cursor && page.keys.length === 0) throw new Error('session_kv_pagination_stalled');
  } while (cursor);

  const pinnedTestChat = sandboxOperatorResetChat(env, target);
  if (pinnedTestChat) chatIds.add(pinnedTestChat);

  // A prior cutover can name a chat whose KV login expired or was already
  // deleted. Include those old destinations so their Intake DO is reset too.
  for (const raw of [env.TG_SLICE_DELIVERY_CUTOVER_MANIFEST, env.TG_SLICE_DELIVERY_CUTOVER_MANIFEST_V2]) {
    if (!raw) continue;
    let manifest;
    try { manifest = JSON.parse(raw); } catch { continue; }
    for (const delivery of manifest?.deliveries ?? []) {
      const chatId = delivery?.destination?.chatId;
      const threadId = delivery?.destination?.threadId;
      if (!Number.isSafeInteger(chatId) || chatId === 0) continue;
      chatIds.add(String(chatId));
      if (Number.isSafeInteger(threadId) && threadId > 0) {
        const selector = { chatId: String(chatId), threadId };
        threadKeys.set(conversationKey(selector.chatId, selector.threadId), selector);
      }
    }
  }

  // Include inboxes without a currently parseable session (for example a chat
  // with an old retry key) in the same chat-level reset.
  const keys = [];
  cursor = undefined;
  do {
    const page = await env.SESSIONS.list({ ...(cursor ? { cursor } : {}) });
    keys.push(...page.keys.map(item => item.name));
    cursor = page.list_complete === false ? page.cursor : null;
  } while (cursor);

  const buffers = [...chatIds].flatMap(chatId => [
    { chatId, threadId: null },
    ...[...threadKeys.values()].filter(item => item.chatId === chatId),
  ]);
  const inspected = [];
  for (const selector of buffers) {
    for (const [bindingName, namespace] of [['intake', env.INTAKE], ['legacyIntake', env.LEGACY_INTAKE]]) {
      if (!namespace) continue;
      const stub = namespace.get(namespace.idFromName(conversationKey(selector.chatId, selector.threadId)));
      const response = await stub.fetch('https://intake/operator/reset-inspect', { method: 'POST' });
      const state = await response.json().catch(() => ({}));
      if (!response.ok) return context.json({ error: 'intake_reset_inspect_failed', binding: bindingName, ...selector }, 503);
      if (state.active && body.mode === 'clear') return context.json({ error: 'active_intake_state', binding: bindingName, ...selector }, 409);
      inspected.push({ selector, binding: bindingName, stub, keys: state.keys ?? 0, active: state.active === true });
    }
  }
  const acceptOnly = env.SANDBOX_ACCEPT_ONLY
    ? env.SANDBOX_ACCEPT_ONLY.get(env.SANDBOX_ACCEPT_ONLY.idFromName('sandbox-accept-only-v1')) : null;
  const acceptOnlyInspectResponse = acceptOnly
    ? await acceptOnly.fetch('https://accept-only.internal/operator/reset-inspect', { method: 'POST' }) : null;
  const acceptOnlyState = acceptOnlyInspectResponse
    ? await acceptOnlyInspectResponse.json().catch(() => ({})) : { keys: 0 };
  if (acceptOnlyInspectResponse && !acceptOnlyInspectResponse.ok) return context.json({ error: 'accept_only_inspect_failed' }, 503);
  if (body.mode === 'inspect') {
    const sandboxUserKeys = (await listSandboxUserKeys(env.TG_SLICE)).length;
    const conversationIndexKeys = (await listSandboxConversationKeys(env.TG_SLICE)).length;
    return context.json({ ok: true, target, sessionAndRetryKeys: keys.length,
      sandboxUserKeys, conversationIndexKeys, intakeBuffers: buffers.length, intakeNamespaces: [...new Set(inspected.map(item => item.binding))],
      durableObjectKeys: inspected.reduce((sum, item) => sum + item.keys, 0),
      acceptOnlyKeys: acceptOnlyState.keys ?? null, active: inspected.some(item => item.active) });
  }
  for (const { selector, stub } of inspected) {
    const response = await stub.fetch('https://intake/operator/reset-all', { method: 'POST' });
    if (!response.ok) return context.json({ error: 'intake_reset_failed', ...selector, status: response.status }, 503);
  }
  const acceptOnlyResponse = acceptOnly
    ? await acceptOnly.fetch('https://accept-only.internal/operator/reset-all', { method: 'POST' }) : null;
  if (acceptOnlyResponse && !acceptOnlyResponse.ok) return context.json({ error: 'accept_only_reset_failed', status: acceptOnlyResponse.status }, 503);
  for (const { selector, stub } of inspected) {
    const response = await stub.fetch('https://intake/operator/reset-inspect', { method: 'POST' });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.active || result.keys !== 0) return context.json({ error: 'intake_reset_verify_failed', ...selector }, 503);
  }
  const acceptOnlyVerify = acceptOnly
    ? await acceptOnly.fetch('https://accept-only.internal/operator/reset-inspect', { method: 'POST' }) : null;
  const acceptOnlyVerified = acceptOnlyVerify ? await acceptOnlyVerify.json().catch(() => ({})) : { keys: 0 };
  if (acceptOnlyVerify && (!acceptOnlyVerify.ok || acceptOnlyVerified.keys !== 0)) return context.json({ error: 'accept_only_reset_verify_failed' }, 503);
  const sandboxUserKeys = await listSandboxUserKeys(env.TG_SLICE);
  const conversationIndexKeys = await listSandboxConversationKeys(env.TG_SLICE);
  for (const key of keys) await env.SESSIONS.delete(key);
  for (const key of sandboxUserKeys) await env.TG_SLICE.delete(key);
  for (const key of conversationIndexKeys) await env.TG_SLICE.delete(key);
  return context.json({ ok: true, target, sessionsAndRetryKeysDeleted: keys.length,
    sandboxUserKeysDeleted: sandboxUserKeys.length, conversationIndexKeysDeleted: conversationIndexKeys.length,
    intakeBuffersReset: buffers.length,
    intakeNamespacesReset: [...new Set(inspected.map(item => item.binding))],
    durableObjectKeysDeleted: inspected.reduce((sum, item) => sum + item.keys, 0), acceptOnlyReset: Boolean(acceptOnly) });
  } finally {
    if (body.mode === 'clear') await env.TG_SLICE.delete(lockKey);
  }
});

async function countKvPrefix(kv, prefix) {
  let count = 0;
  let cursor;
  do {
    const page = await kv.list({ prefix, ...(cursor ? { cursor } : {}) });
    count += page.keys.length;
    cursor = page.list_complete === false ? page.cursor : null;
  } while (cursor);
  return count;
}

async function listKvPrefix(kv, prefix) {
  const keys = [];
  let cursor;
  do {
    const page = await kv.list({ prefix, ...(cursor ? { cursor } : {}) });
    keys.push(...page.keys.map(item => item.name));
    cursor = page.list_complete === false ? page.cursor : null;
  } while (cursor);
  return keys;
}

async function listSandboxUserKeys(kv) {
  const [legacy, namespaced] = await Promise.all([
    listKvPrefix(kv, 'user:'), listKvPrefix(kv, 'sandbox-user:'),
  ]);
  return [...new Set([...legacy, ...namespaced])];
}

async function listSandboxConversationKeys(kv) {
  return listKvPrefix(kv, 'conv:tg-');
}

// A signed, isolated message fixture exercises the same webhook ingress and
// Intake DO append path as a real user message without needing Telegram's
// write-only webhook secret or sending anything to a real chat.
app.post('/operator/test-buffer-message', async context => {
  const env = executionEnv(context.env);
  const target = sandboxOperatorLane(env);
  const token = sandboxOperatorToken(env, target);
  if (!token || context.req.header('authorization') !== `Bearer ${token}`) return context.json({ error: 'unauthorized' }, 401);
  if (await env.TG_SLICE?.get?.(`sandbox-state-reset:${env.SESSION_NAMESPACE}`)) return context.json({ error: 'reset_in_progress' }, 503);
  const configuredBufferChatId = target === 'sandbox3'
    ? sandboxOperatorResetChat(env, target) : env.TG_SANDBOX_BUFFER_TEST_CHAT_ID;
  const configuredBufferUserId = target === 'sandbox3'
    ? env.TG_SANDBOX_E2E_USER_ID : '900000236';
  if (!target || env.TG_SANDBOX_TEST_API_ENABLED !== 'true' ||
      env.TG_SLICE_INGRESS_PAUSED === 'true' || env.TG_SLICE_DELIVERY_PAUSED !== 'false' || !configuredBufferChatId) {
    return context.json({ error: 'sandbox_buffer_test_not_ready' }, 409);
  }
  const config = readTgSliceConfig(env);
  const source = await context.req.json().catch(() => null);
  if (!source || source.target !== target || typeof source.text !== 'string' || !source.text.trim() ||
      !source.text.startsWith('sandbox-buffer-test ') || source.text.length > 2000 ||
      (source.resetAfter !== undefined && typeof source.resetAfter !== 'boolean') ||
      Object.keys(source).some(key => !['target', 'text', 'resetAfter'].includes(key))) {
    return context.json({ error: 'invalid_test_message' }, 400);
  }
  const chatId = Number(configuredBufferChatId);
  if (!Number.isSafeInteger(chatId) || chatId === 0 || (target === 'sandbox' && chatId >= 0)) return context.json({ error: 'invalid_sandbox_test_chat' }, 409);
  const userId = Number(configuredBufferUserId);
  if (!Number.isSafeInteger(userId) || userId <= 0) return context.json({ error: 'invalid_sandbox_test_user' }, 409);
  // This synthetic webhook must exercise the real ingress and Intake DO without
  // writing its fixture login into the shared sandbox KV. KV deletes are
  // eventually visible, which otherwise leaves one test session behind and
  // makes the next clean-state gate wait or fail.
  const sessionStore = createEphemeralSessionStore();
  const runtimeEnv = executionEnv({ ...context.env, SESSIONS: sessionStore, TG_HTTP_TEST_MODE: 'true' });
  const testEnv = executionEnv({ ...context.env, SESSIONS: sessionStore, TG_HTTP_TEST_MODE: 'true',
    TG_SLICE_ALLOWED_CHATS: [...new Set([...config.allowedChats, String(chatId)])].join(','),
    TG_SLICE_ALLOWED_USERS: [...new Set([...String(context.env.TG_SLICE_ALLOWED_USERS ?? '').split(',').map(value => value.trim()).filter(Boolean), String(userId)])].join(',') });
  await setSession(runtimeEnv.SESSIONS, chatId, { username: 'sandbox-buffer-test',
    telegramUserId: String(userId), controlPlaneProfile: config.profileId });
  const update = { update_id: Date.now(), message: { message_id: Date.now() % 1_000_000_000,
    date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: chatId > 0 ? 'private' : 'supergroup', is_forum: false },
    from: { id: userId, is_bot: false, first_name: 'Sandbox' }, text: source.text } };
  const response = await app.fetch(new Request('https://sandbox.internal/webhook', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': config.webhookSecret },
    body: JSON.stringify(update),
  }), { ...testEnv, TG_HTTP_TEST_MODE: 'true', TEST_CHAT_IDS: String(chatId) });
  const admitted = await response.json().catch(() => ({}));
  if (!response.ok || admitted.ok !== true) return context.json({ error: 'synthetic_webhook_failed', status: response.status, code: admitted.code ?? null }, 503);
  const stub = env.INTAKE.get(env.INTAKE.idFromName(conversationKey(chatId, null)));
  const bufferResponse = await stub.fetch('https://intake/debug');
  const buffer = await bufferResponse.json();
  if (source.resetAfter === true) {
    const cleared = await stub.fetch('https://intake/operator/reset-all', { method: 'POST' });
    const clearedBody = await cleared.json().catch(() => ({}));
    if (!cleared.ok || !clearedBody.ok) return context.json({ error: 'test_buffer_cleanup_failed' }, 503);
  }
  return context.json({ ok: true, updateId: update.update_id, chatId, admitted,
    buffer: { pendingCount: buffer.buf?.length ?? 0, hasText: buffer.buf?.some(item => item.hasText) ?? false,
      busy: buffer.busy, stranded: buffer.stranded }, clearedAfterRead: source.resetAfter === true });
});

// Owner-authenticated test ingress: submit a Telegram-shaped message or button
// press to the same webhook handler, then receive its immediate bot replies as
// JSON. This endpoint exists only on the isolated UX sandbox Worker.
app.post('/operator/test-update', async context => {
  const env = executionEnv(context.env);
  const target = sandboxOperatorLane(env);
  const token = sandboxOperatorToken(env, target);
  if (!token || context.req.header('authorization') !== `Bearer ${token}`) return context.json({ error: 'unauthorized' }, 401);
  if (await env.TG_SLICE.get(`sandbox-state-reset:${env.SESSION_NAMESPACE}`)) return context.json({ error: 'reset_in_progress' }, 503);
  if (env.TG_SANDBOX_TEST_API_ENABLED !== 'true' || !target ||
      env.TG_SLICE_INGRESS_PAUSED === 'true' || env.TG_SLICE_DELIVERY_PAUSED !== 'false') {
    return context.json({ error: 'sandbox_test_api_not_ready' }, 409);
  }
  const source = await context.req.json().catch(() => null);
  if (!source || source.target !== target || !['message', 'callback'].includes(source.type) ||
      Object.keys(source).some(key => !['target', 'type', 'text', 'callbackData', 'updateId', 'messageId', 'chatId', 'userId', 'delivery', 'admin'].includes(key)) ||
      (source.delivery !== undefined && !['capture', 'telegram'].includes(source.delivery)) ||
      (source.admin !== undefined && typeof source.admin !== 'boolean') ||
      (source.userId !== undefined && (!Number.isSafeInteger(source.userId) || source.userId < 1)) ||
      (source.updateId !== undefined && (!Number.isSafeInteger(source.updateId) || source.updateId < 0))) {
    return context.json({ error: 'invalid_test_update' }, 400);
  }
  if (source.type === 'message' && (typeof source.text !== 'string' || !source.text.trim() || source.text.length > 4000) ||
      source.type === 'message' && source.messageId !== undefined && (!Number.isSafeInteger(source.messageId) || source.messageId < 1) ||
      source.type === 'callback' && (typeof source.callbackData !== 'string' || !source.callbackData || source.callbackData.length > 64 ||
        source.messageId !== undefined && (!Number.isSafeInteger(source.messageId) || source.messageId < 1))) return context.json({ error: 'invalid_test_update' }, 400);
  const config = readTgSliceConfig(env);
  if (!config.webhookSecret) return context.json({ error: 'sandbox_webhook_not_ready' }, 409);
  const configuredTestChat = source.chatId ?? env.TG_SANDBOX_E2E_CHAT_ID;
  if (configuredTestChat === undefined || configuredTestChat === null || configuredTestChat === '') {
    return context.json({ error: 'sandbox_test_chat_required' }, 409);
  }
  const chatId = Number(configuredTestChat);
  if (!Number.isSafeInteger(chatId) || chatId === 0) return context.json({ error: 'invalid_sandbox_test_chat' }, 409);
  const actorId = source.userId ?? 900000236;
  if (!sandboxOperatorChatAllowed(env, config, target, chatId) ||
      !sandboxOperatorUserAllowed(env, target, actorId)) return context.json({ error: 'sandbox_test_identity_not_allowed' }, 403);
  if (!env.INTAKE) return context.json({ error: 'sandbox_intake_not_ready' }, 409);
  const intake = env.INTAKE.get(env.INTAKE.idFromName(conversationKey(chatId, null)));
  const readCollectorState = async () => {
    const stateResponse = await intake.fetch('https://intake/debug');
    return stateResponse.ok ? stateResponse.json().catch(() => null) : null;
  };
  const before = await readCollectorState();
  if (source.type === 'callback' && source.messageId === undefined && !Number.isSafeInteger(before?.collectorMsgId)) {
    return context.json({ error: 'no_current_button_message' }, 409);
  }
  const callbackShortcut = source.type === 'callback' && ['auto', 'explore', 'answer', 'intake_run'].includes(source.callbackData)
    ? (source.callbackData === 'intake_run' ? 'auto' : source.callbackData) : null;
  if (callbackShortcut && !Number.isSafeInteger(before?.collectorDraftRevision)) {
    return context.json({ error: 'no_current_button_revision' }, 409);
  }
  const callbackData = callbackShortcut
    ? `ws|${callbackShortcut}|${before.collectorDraftRevision}` : source.callbackData;
  const updateId = source.updateId ?? Date.now();
  const messageId = source.messageId ?? (source.type === 'callback' ? before.collectorMsgId : updateId % 1_000_000_000);
  const message = { message_id: messageId, date: Math.floor(Date.now() / 1000),
    chat: { id: chatId, type: chatId > 0 ? 'private' : 'supergroup', is_forum: false },
    from: { id: actorId, is_bot: false, first_name: 'Sandbox test' },
    ...(source.type === 'message' ? { text: source.text } : {}) };
  const update = source.type === 'message' ? { update_id: updateId, message } : {
    update_id: updateId, callback_query: { id: `sandbox-test-${updateId}`, from: message.from,
      message, chat_instance: 'sandbox-test', data: callbackData },
  };
  if (source.type === 'callback') rememberCallback(update.callback_query.id, chatId);
  const deliverToTelegram = source.delivery === 'telegram';
  const testEnv = { ...context.env, TEST_CHAT_IDS: deliverToTelegram ? '' : String(chatId),
    TG_SLICE_ALLOWED_CHATS: [...new Set([...config.allowedChats, String(chatId)])].join(','),
    TG_SLICE_ALLOWED_USERS: [...new Set([...String(context.env.TG_SLICE_ALLOWED_USERS ?? '').split(',').map(value => value.trim()).filter(Boolean), String(actorId)])].join(','),
    ...(source.admin === true ? { ADMIN_GROUP_ID: String(chatId) } : {}) };
  const capture = beginTestCapture(chatId, { deliverToTelegram });
  if (!capture) return context.json({ error: 'sandbox_test_api_busy' }, 409);
  initTestMode(testEnv);
  let response;
  let admission;
  try {
    response = await app.fetch(new Request('https://sandbox.internal/webhook', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': config.webhookSecret },
      body: JSON.stringify(update),
    }), testEnv);
    admission = await response.json().catch(() => ({}));
  } catch {
    const transcript = capture();
    initTestMode(context.env);
    return context.json({ error: 'synthetic_webhook_failed', transcript }, 503);
  }
  const transcript = capture();
  initTestMode(context.env);
  if (!response.ok) return context.json({ error: 'synthetic_webhook_failed', status: response.status,
    code: admission.code ?? null, transcript }, 503);
  const after = await readCollectorState();
  const collector = after ? {
    busy: after.busy === true,
    pendingCount: (after.buf?.length ?? 0) + (after.retryBatch?.length ?? 0),
    stranded: after.stranded === true,
    collectorMessageId: after.collectorMsgId ?? null,
    collectorDraftRevision: after.collectorDraftRevision ?? null,
    launchingMessageIds: (after.launching ?? []).map(item => item.messageId).filter(Number.isSafeInteger),
    controlPlaneBarrier: after.controlPlaneBarrier ?? null,
  } : null;
  return context.json({ ok: true, updateId, messageId, chatId, userId: actorId, delivery: deliverToTelegram ? 'telegram' : 'capture',
    admin: source.admin === true, callbackData: source.type === 'callback' ? callbackData : undefined,
    admission, transcript, collector });
});

app.post('/webhook', async context => {
  const env = executionEnv(context.env);
  const config = readTgSliceConfig(env);
  if (!config.webhookSecret || context.req.header('x-telegram-bot-api-secret-token') !== config.webhookSecret) return context.json({ error: 'unsigned update refused' }, 401);
  if (await env.TG_SLICE?.get?.(`sandbox-state-reset:${env.SESSION_NAMESPACE}`)) return context.json({ error: 'sandbox state reset in progress' }, 503);
  if (context.env.TG_SLICE_INGRESS_PAUSED === 'true') return context.json({ error: 'sandbox ingress paused' }, 503);
  const update = await context.req.json().catch(() => null);
  if (!Number.isSafeInteger(update?.update_id)) return context.json({ error: 'bad update' }, 400);
  const message = update.message ?? update.callback_query?.message;
  const sender = update.callback_query?.from ?? message?.from;
  const allowedUsers = String(env.TG_SLICE_ALLOWED_USERS ?? '').split(',').map(value => value.trim()).filter(Boolean);
  if (config.e2eUserId && !allowedUsers.includes(config.e2eUserId)) allowedUsers.push(config.e2eUserId);
  if (!message?.chat || !sender?.id || (!config.openSandbox &&
      (!config.allowedChats.includes(String(message.chat.id)) || !allowedUsers.includes(String(sender.id))))) return context.json({ error: 'owner refused' }, 403);
  if (!env.SESSIONS) return context.json({ error: 'session store not configured' }, 503);
  const threadId = threadIdOf(message);
  const runtimeEnv = executionEnv(env);
  const command = String(message.text ?? '').trim().split(/\s+/)[0].split('@')[0].toLowerCase();
  let session = await getSession(runtimeEnv.SESSIONS, message.chat.id, threadId);
  if (session?.controlPlaneProfile && session.controlPlaneProfile !== config.profileId
      && !(session.telegramUserId === String(sender.id) && /^prof-[0-9a-f-]{36}$/.test(session.controlPlaneProfile))) {
    return context.json({ error: 'profile mismatch' }, 403);
  }

  const registrationInProgress = session?.registrationStep && session.registrationStep !== 'complete';
  if (config.openSandbox && session?.registrationStep === 'complete'
      && session.telegramUserId === String(sender.id) && /^prof-[0-9a-f-]{36}$/.test(session.controlPlaneProfile)) {
    // Registration identities must never fall through to the legacy login or
    // shared IntakeBuffer. Per-profile API execution is enabled only once the
    // CP has quota accounting and the Agent API workspace capability configured.
    return context.json({ error: 'profile execution is not enabled for this sandbox yet', code: 'PROFILE_EXECUTION_NOT_ENABLED' }, 503);
  }
  if (config.openSandbox && message.chat.type === 'private'
      && (command === '/start' || registrationInProgress)) {
    const clientConfig = { ...config, telegramUserId: String(sender.id) };
    const registrationClient = new ControlPlaneClient(clientConfig, {
      fetchImpl: env.CONTROL_PLANE_SERVICE ? env.CONTROL_PLANE_SERVICE.fetch.bind(env.CONTROL_PLANE_SERVICE) : undefined,
      logSink: line => console.log(line),
    });
    let registration;
    try { registration = (await registrationClient.registerTelegramUpdate(update)).value; }
    catch { return context.json({ error: 'registration service unavailable' }, 503); }
    const completed = registration?.step === 'complete';
    session = {
      username: completed ? `telegram-${sender.id}` : null,
      telegramUserId: String(sender.id),
      controlPlaneProfile: completed ? registration.profileId : null,
      registrationStep: completed ? 'complete' : registration?.step,
      registeredAt: completed ? (session?.registeredAt ?? Date.now()) : null,
    };
    await setSession(runtimeEnv.SESSIONS, message.chat.id, session, threadId);
    const text = String(registration?.message ?? 'Продолжите регистрацию.');
    if (env.TG_HTTP_TEST_MODE !== 'true') {
      if (registration?.step === 'profile_name') {
        await sendMessageWithKeyboard(env.TG_SANDBOX_BOT_TOKEN, message.chat.id, text,
          [[{ text: 'Пропустить', callback_data: 'registration_skip' }]], {}, runtimeEnv);
      } else await sendMessage(env.TG_SANDBOX_BOT_TOKEN, message.chat.id, text);
    }
    return context.json({ ok: true, registration, transcript: [text],
      buttons: registration?.step === 'profile_name' ? [{ text: 'Пропустить', callbackData: 'registration_skip' }] : [] });
  }

  if (!env.INTAKE || env.INTAKE_DEBOUNCE === 'off') return context.json({ error: 'collector not configured' }, 503);
  await createController(env, config).outbox.open();

  // Older sandbox builds silently assigned every sender the same synthetic
  // `integrator` profile. Keep those sessions inert and let the existing
  // username/password login replace them explicitly.
  if (session?.username === 'integrator') {
    if (command === '/login') {
      await deleteSession(runtimeEnv.SESSIONS, message.chat.id, threadId);
      session = null;
    } else session = null;
  }

  if (command === '/login') {
    await cmdLogin(message, runtimeEnv);
    const authenticated = await getSession(runtimeEnv.SESSIONS, message.chat.id, threadId);
    if (authenticated?.username && authenticated.username !== 'integrator') {
      await setSession(runtimeEnv.SESSIONS, message.chat.id,
        { ...authenticated, controlPlaneProfile: config.profileId }, threadId);
    }
    return context.json({ ok: true, authenticated: !!authenticated?.username && authenticated.username !== 'integrator' });
  }

  if (isUserMgmtCommand(message.text ?? '')) {
    if (!config.allowedChats.includes(String(message.chat.id)) || !allowedUsers.includes(String(sender.id))) {
      await sendMessage(env.TG_SANDBOX_BOT_TOKEN, message.chat.id,
        'Эта команда доступна оператору тестового бота.');
      return context.json({ ok: true, refused: true });
    }
    const userMessage = command === '/pass_reset'
      ? { ...message, text: message.text.replace(/^\/pass_reset(?=@|\s|$)/i, '/resetpass') }
      : message;
    await handleUserMgmt(userMessage, runtimeEnv);
    return context.json({ ok: true });
  }

  // Exact service commands must bypass Intake: they are immediate replies and
  // must not wait for the collector's work-style prompt or launch an agent.
  if (message.text && /^\/help(?:@[a-z0-9_]+)?$/i.test(message.text.trim())) {
    await sendMessage(env.TG_SANDBOX_BOT_TOKEN, message.chat.id,
      'Команды: /help, /status. Сообщение с вопросом отправь обычным текстом.', threadExtra(threadId));
    return context.json({ ok: true, serviceCommand: 'help' });
  }
  if (message.text && /^\/status(?:@[a-z0-9_]+)?$/i.test(message.text.trim())) {
    const stub = env.INTAKE.get(env.INTAKE.idFromName(conversationKey(message.chat.id, threadId)));
    const response = await stub.fetch('https://intake/debug');
    if (!response.ok) return context.json({ error: 'status_unavailable' }, 503);
    const state = await response.json().catch(() => null);
    if (!state || typeof state !== 'object') return context.json({ error: 'status_unavailable' }, 503);
    const pending = [...(Array.isArray(state.buf) ? state.buf : []), ...(Array.isArray(state.retryBatch) ? state.retryBatch : [])]
      .filter(item => item.hasText || item.mediaPending).length;
    const barrier = state.controlPlaneBarrier ?? {};
    const active = state.busy || (Array.isArray(state.launching) && state.launching.length > 0) ||
      Number(barrier.busyRequestCount ?? 0) > 0 || Number(barrier.unresolvedLaunchCount ?? 0) > 0;
    const text = active ? 'Сейчас обрабатываю задачу.'
      : pending > 0 ? `Собран ввод: ${pending} ${pending === 1 ? 'сообщение' : 'сообщений'}.` : 'Активных задач и несобранного ввода нет.';
    await sendMessage(env.TG_SANDBOX_BOT_TOKEN, message.chat.id, text, threadExtra(threadId));
    return context.json({ ok: true, serviceCommand: 'status', active, pending });
  }
  if (!session?.username || session.username === 'integrator') {
    if (update.callback_query) {
      await answerCallbackQuery(env.TG_SANDBOX_BOT_TOKEN, update.callback_query.id,
        'Сначала войди: /login username password');
      return context.json({ ok: true, authenticated: false });
    }
    if (String(message.text ?? '').trim().startsWith('/')) {
      await sendMessage(env.TG_SANDBOX_BOT_TOKEN, message.chat.id,
        'Команда не распознана. Логин профиля можно посмотреть командой /listusers в исходном админ-чате.\n' +
        'Здесь, в sandbox, выполни /pass_reset username — бот пришлёт тестовый пароль и команду входа.\n' +
        'Для входа: /login username password.');
      return context.json({ ok: true, authenticated: false, unknownCommand: true });
    }
    await sendMessage(env.TG_SANDBOX_BOT_TOKEN, message.chat.id,
      'Чтобы войти в этом чате, отправь <code>/login username password</code>.\n' +
      'Один и тот же профиль можно подключить отдельно в каждом чате.');
    return context.json({ ok: true, authenticated: false });
  }
  initTestMode(env);
  if (update.callback_query) {
    rememberCallback(update.callback_query.id, message.chat.id);
    const data = update.callback_query.data ?? '';
    const stopBlocked = data.startsWith('intake_stop') && env.TG_SLICE_STOP_ENABLED !== 'true';
    const supported = ['intake_run', 'intake_parallel', 'intake_cancel', 'intake_stopsupp', 'intake_stopnew', 'input_draft', 'input_run'].includes(data)
      || /^intake_dismiss_unknown\|[a-f0-9-]{36}$/.test(data)
      || /^ws\|(explore|answer|auto)\|\d+$/.test(data)
      || /^intake_discard\|\d+$/.test(data)
      || ['intake_stopyes|', 'intake_stopno|', 'input_run|'].some(prefix => data.startsWith(prefix));
    if (!supported || stopBlocked) {
      await answerCallbackQuery(env.BOT_TOKEN, update.callback_query.id, 'Эта функция ещё не подключена к новому Control Plane.');
      return context.json({ ok: true, unsupported: true });
    }
    await handleCallbackQuery(update.callback_query, env);
    return context.json({ ok: true });
  }
  if (!hasIntakeContent(message)) return context.json({ ok: true, unsupported: true });
  const stub = env.INTAKE.get(env.INTAKE.idFromName(conversationKey(message.chat.id, threadId)));
  const flush = FORCE_RUN_RE.test(message.text ?? '') || AUTO_LAUNCH_RE.test(message.text ?? '');
  const response = await stub.fetch('https://intake/append', {
    method: 'POST', body: JSON.stringify({ text: message.text ?? message.caption, msg: message, flush, telegramUpdateId: update.update_id }),
  });
  if (!response.ok) return context.json({ error: 'collector admission failed' }, 503);
  return context.json({ ok: true, ...(await response.json()) });
});

app.get('/deliveries/:taskId', async context => {
  const config = readTgSliceConfig(context.env);
  if (context.req.header('x-telegram-bot-api-secret-token') !== config.webhookSecret) return context.json({ error: 'unauthorized' }, 401);
  const taskId = context.req.param('taskId');
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(taskId)) return context.json({ error: 'invalid task id' }, 400);
  return context.json(await createController(context.env, config).outbox.read(taskId));
});

export default {
  fetch: app.fetch,
  async scheduled(event, env) {
    const controller = createController(env);
    await controller.outbox.open();
    await controller.reconcile();
  },
};

export class IntakeBufferReset extends IntakeBuffer {}

export { IntakeBuffer, TgDeliveryOwner, TgDeliveryOwnerV2, SandboxAcceptOnlyStore };
