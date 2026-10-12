// Configuration of the Telegram CP route: only from Worker environment.
//
// Sandbox deployments use their own Worker and bot. The main production Worker
// may opt into a separately pinned production E2E identity/profile; its existing
// src/index.js handlers and webhook remain the production entrypoint.
//
// Fail-closed rules:
//  - sandbox deployments refuse production bot identities;
//  - production CP mode requires the exact owner-pinned E2E profile and chat;
//  - no chat is served unless it is explicitly listed in TG_SLICE_ALLOWED_CHATS;
//  - the webhook refuses updates without a configured and matching secret token.

export const PRODUCTION_BOT_USERNAMES = [
  'super_personal_assistant_bot',
  'super_recruiter_assistant_bot',
  'freelance_spec_bot',
];

export class TgSliceConfigError extends Error {
  constructor(message, variable) {
    super(message);
    this.name = 'TgSliceConfigError';
    this.variable = variable;
  }
}

const num = (env, name, fallback, min, max) => {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new TgSliceConfigError(`${name} must be a number in ${min}..${max}`, name);
  }
  return value;
};

const requireVar = (env, name) => {
  const value = String(env[name] ?? '').trim();
  if (!value) throw new TgSliceConfigError(`${name} is required (env only; nothing is read from the repo)`, name);
  return value;
};

const stripTrailingSlash = url => String(url).replace(/\/+$/, '');

const parseChatList = raw =>
  String(raw ?? '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);

export function readTgSliceConfig(env) {
  const productionE2eMode = env.TG_PRODUCTION_E2E_MODE === 'true';
  const botUsername = String(env.TG_SANDBOX_BOT_USERNAME ?? env.BOT_USERNAME ?? '').trim().replace(/^@/, '');
  if (!botUsername) throw new TgSliceConfigError('TG_SANDBOX_BOT_USERNAME or BOT_USERNAME is required', 'BOT_USERNAME');
  if (PRODUCTION_BOT_USERNAMES.includes(botUsername) && !productionE2eMode) {
    throw new TgSliceConfigError(
      `TG_SANDBOX_BOT_USERNAME "${botUsername}" is a production bot identity — the sandbox slice refuses to run as a production bot`,
      'TG_SANDBOX_BOT_USERNAME',
    );
  }
  const transport = String(env['TG_SLICE_EVENT_TRANSPORT'] ?? 'auto').trim();
  if (!['auto', 'events-endpoint', 'status-history'].includes(transport)) {
    throw new TgSliceConfigError('TG_SLICE_EVENT_TRANSPORT must be auto|events-endpoint|status-history', 'TG_SLICE_EVENT_TRANSPORT');
  }
  const allowedChats = parseChatList(env['TG_SLICE_ALLOWED_CHATS']);
  const controlPlaneUrl = stripTrailingSlash(requireVar(env, 'CONTROL_PLANE_URL'));
  const productionE2e = controlPlaneUrl === 'https://trained-assist-cp-production.skillset-apply.workers.dev'
    && env.CONTROL_PLANE_PRINCIPAL === 'production-e2e-telegram-v1'
    && env.CONTROL_PLANE_PROFILE === 'production-e2e-telegram-v1'
    && env.SESSION_NAMESPACE === 'integrator-production-e2e-v1'
    && ((env.TG_ACCEPT_ONLY_ENVIRONMENT === 'sandbox' && botUsername === 'ptichka_status_bot'
        && env.TG_SANDBOX_TEST_API_ENABLED === 'true')
      || (productionE2eMode && env.TG_ACCEPT_ONLY_ENVIRONMENT === 'production-e2e'
        && botUsername === 'super_personal_assistant_bot'
        && env.TG_SANDBOX_TEST_API_ENABLED !== 'true'));
  if (controlPlaneUrl === 'https://trained-assist-cp-production.skillset-apply.workers.dev'
      && !productionE2e && (env.TG_ACCEPT_ONLY_ENVIRONMENT === 'sandbox' || productionE2eMode)) {
    throw new TgSliceConfigError('Production CP is permitted only for the pinned production E2E sandbox lane', 'CONTROL_PLANE_URL');
  }
  if (productionE2eMode) {
    const pinnedChat = String(env.TG_SANDBOX_E2E_CHAT_ID ?? '').trim();
    const pinnedUser = String(env.TG_SANDBOX_E2E_USER_ID ?? '').trim();
    const allowedUsers = parseChatList(env.TG_SLICE_ALLOWED_USERS);
    if (env.TG_ACCEPT_ONLY_ENVIRONMENT !== 'production-e2e' || env.TG_SLICE_OPEN_SANDBOX === 'true'
        || !/^[1-9]\d*$/.test(pinnedChat) || pinnedChat !== pinnedUser
        || allowedChats.length !== 1 || allowedChats[0] !== pinnedChat
        || allowedUsers.length !== 1 || allowedUsers[0] !== pinnedUser) {
      throw new TgSliceConfigError('Production E2E must be pinned to one private chat and its sender', 'TG_SLICE_ALLOWED_CHATS');
    }
  }
  const e2eChatId = String(env.TG_SANDBOX_E2E_CHAT_ID ?? '').trim();
  if (e2eChatId) {
    if (!(env.TG_ACCEPT_ONLY_ENVIRONMENT === 'sandbox' || productionE2eMode) || !/^[1-9]\d*$/.test(e2eChatId)) {
      throw new TgSliceConfigError('TG_SANDBOX_E2E_CHAT_ID must be a nonzero numeric sandbox chat or pinned production private chat', 'TG_SANDBOX_E2E_CHAT_ID');
    }
    if (!allowedChats.includes(e2eChatId)) allowedChats.push(e2eChatId);
  }
  const e2eUserId = String(env.TG_SANDBOX_E2E_USER_ID ?? '').trim();
  if (e2eUserId && (!(env.TG_ACCEPT_ONLY_ENVIRONMENT === 'sandbox' || productionE2eMode) || !/^[1-9]\d*$/.test(e2eUserId))) {
    throw new TgSliceConfigError('TG_SANDBOX_E2E_USER_ID must be a positive numeric pinned test user', 'TG_SANDBOX_E2E_USER_ID');
  }
  const openSandbox = env.TG_SLICE_OPEN_SANDBOX === 'true';
  if (openSandbox && env.TG_ACCEPT_ONLY_ENVIRONMENT !== 'sandbox') {
    throw new TgSliceConfigError('TG_SLICE_OPEN_SANDBOX is permitted only for a sandbox Worker', 'TG_ACCEPT_ONLY_ENVIRONMENT');
  }
  const chatProfiles = {};
  if (!productionE2e) {
    for (const entry of parseChatList(env['TG_SLICE_CHAT_PROFILES'])) {
      const [chatId, profileId] = entry.split(':').map(part => part.trim());
      if (chatId && profileId) chatProfiles[chatId] = profileId;
    }
  }
  return {
    botUsername,
    openSandbox,
    botToken: String(env.TG_SANDBOX_BOT_TOKEN ?? env.BOT_TOKEN ?? '').trim()
      || requireVar(env, 'TG_SANDBOX_BOT_TOKEN'),
    controlPlaneUrl,
    principalId: requireVar(env, 'CONTROL_PLANE_PRINCIPAL'),
    principalSignature: productionE2e
      ? requireVar(env, 'CONTROL_PLANE_PRODUCTION_E2E_SIGNATURE')
      : String(env['CONTROL_PLANE_PRINCIPAL_SIGNATURE'] ?? '').trim() || null,
    routeBeforeStart: env.TG_SLICE_ROUTER_ENABLED === 'true',
    profileId: requireVar(env, 'CONTROL_PLANE_PROFILE'),
    apiKey: String(env['CONTROL_PLANE_API_KEY'] ?? '').trim() || null,
    sessionId: productionE2e ? null : String(env['CONTROL_PLANE_SESSION_ID'] ?? '').trim() || null,
    telegramApiBase: stripTrailingSlash(String(env['TELEGRAM_API_BASE'] ?? 'https://api.telegram.org')),
    webhookSecret: String(env['TELEGRAM_WEBHOOK_SECRET'] ?? env['BOT_SECRET'] ?? '').trim() || null,
    allowedChats,
    e2eUserId: e2eUserId && (env.TG_ACCEPT_ONLY_ENVIRONMENT === 'sandbox' || productionE2eMode) ? e2eUserId : null,
    chatProfiles,
    requestTimeoutMs: num(env, 'TG_SLICE_REQUEST_TIMEOUT_MS', 5000, 100, 60000),
    routeRequestTimeoutMs: num(env, 'TG_SLICE_ROUTE_REQUEST_TIMEOUT_MS', 140000, 100, 180000),
    pollIntervalMs: num(env, 'TG_SLICE_POLL_INTERVAL_MS', 250, 10, 10000),
    batchWindowMs: num(env, 'TG_SLICE_BATCH_WINDOW_MS', 3000, 0, 60000),
    maxBatchItems: num(env, 'TG_SLICE_MAX_BATCH_ITEMS', 20, 1, 100),
    deliveryMaxAttempts: num(env, 'TG_SLICE_DELIVERY_MAX_ATTEMPTS', 6, 1, 20),
    deliveryRetryBaseMs: num(env, 'TG_SLICE_DELIVERY_RETRY_BASE_MS', 1000, 100, 60000),
    eventTransport: transport,
    productionE2eMode,
    maxTurns: num(env, 'TG_SLICE_MAX_TURNS', 32, 1, 512),
  };
}

export function chatAllowed(config, chatId) {
  return config.openSandbox === true || config.allowedChats.includes(String(chatId));
}

/** Which auth scheme the slice uses — for logs and reports (never the key itself). */
export function authScheme(config) {
  if (config.principalSignature) return 'x-principal+signature';
  return config.apiKey ? 'x-principal+bearer' : 'x-principal';
}

export default { readTgSliceConfig, authScheme, PRODUCTION_BOT_USERNAMES, TgSliceConfigError };
