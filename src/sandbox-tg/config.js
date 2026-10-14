// Configuration of the Telegram CP route: only from Worker environment.
//
// Sandbox deployments use their own Worker and bot. Production E2E uses the
// actual production Worker and its normal account/profile path.
//
// Fail-closed rules:
//  - sandbox deployments refuse production bot identities;
//  - sandbox Workers can never call the production Control Plane;
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
  const botUsername = String(env.TG_SANDBOX_BOT_USERNAME ?? env.BOT_USERNAME ?? '').trim().replace(/^@/, '');
  if (!botUsername) throw new TgSliceConfigError('TG_SANDBOX_BOT_USERNAME or BOT_USERNAME is required', 'BOT_USERNAME');
  // Production bot identities are accepted only by their ordinary production
  // Worker configuration. Test bots cannot opt into the production route.
  const productionMode = PRODUCTION_BOT_USERNAMES.includes(botUsername)
    && env.EXECUTION_BACKEND === 'control-plane'
    && env.TG_ACCEPT_ONLY_ENVIRONMENT !== 'sandbox';
  if (PRODUCTION_BOT_USERNAMES.includes(botUsername) && !productionMode) {
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
  if (controlPlaneUrl === 'https://trained-assist-cp-production.skillset-apply.workers.dev'
      && !productionMode) {
    throw new TgSliceConfigError('Production CP is permitted only for an ordinary production Worker', 'CONTROL_PLANE_URL');
  }
  const e2eChatId = String(env.TG_SANDBOX_E2E_CHAT_ID ?? '').trim();
  if (e2eChatId) {
    if (env.TG_ACCEPT_ONLY_ENVIRONMENT !== 'sandbox' || !/^[1-9]\d*$/.test(e2eChatId)) {
      throw new TgSliceConfigError('TG_SANDBOX_E2E_CHAT_ID must be a nonzero numeric sandbox chat', 'TG_SANDBOX_E2E_CHAT_ID');
    }
    if (!allowedChats.includes(e2eChatId)) allowedChats.push(e2eChatId);
  }
  const e2eUserId = String(env.TG_SANDBOX_E2E_USER_ID ?? '').trim();
  if (e2eUserId && (env.TG_ACCEPT_ONLY_ENVIRONMENT !== 'sandbox' || !/^[1-9]\d*$/.test(e2eUserId))) {
    throw new TgSliceConfigError('TG_SANDBOX_E2E_USER_ID must be a positive numeric pinned sandbox user', 'TG_SANDBOX_E2E_USER_ID');
  }
  const openSandbox = env.TG_SLICE_OPEN_SANDBOX === 'true';
  if (openSandbox && env.TG_ACCEPT_ONLY_ENVIRONMENT !== 'sandbox') {
    throw new TgSliceConfigError('TG_SLICE_OPEN_SANDBOX is permitted only for a sandbox Worker', 'TG_ACCEPT_ONLY_ENVIRONMENT');
  }
  const chatProfiles = {};
  for (const entry of parseChatList(env['TG_SLICE_CHAT_PROFILES'])) {
    const [chatId, profileId] = entry.split(':').map(part => part.trim());
    if (chatId && profileId) chatProfiles[chatId] = profileId;
  }
  return {
    botUsername,
    openSandbox,
    botToken: String(env.TG_SANDBOX_BOT_TOKEN ?? env.BOT_TOKEN ?? '').trim()
      || requireVar(env, 'TG_SANDBOX_BOT_TOKEN'),
    controlPlaneUrl,
    principalId: requireVar(env, 'CONTROL_PLANE_PRINCIPAL'),
    principalSignature: productionMode
      ? requireVar(env, 'CONTROL_PLANE_PRINCIPAL_SIGNATURE')
      : String(env['CONTROL_PLANE_PRINCIPAL_SIGNATURE'] ?? '').trim() || null,
    routeBeforeStart: env.TG_SLICE_ROUTER_ENABLED === 'true',
    profileId: requireVar(env, 'CONTROL_PLANE_PROFILE'),
    apiKey: String(env['CONTROL_PLANE_API_KEY'] ?? '').trim() || null,
    sessionId: String(env['CONTROL_PLANE_SESSION_ID'] ?? '').trim() || null,
    telegramApiBase: stripTrailingSlash(String(env['TELEGRAM_API_BASE'] ?? 'https://api.telegram.org')),
    webhookSecret: String(env['TELEGRAM_WEBHOOK_SECRET'] ?? env['BOT_SECRET'] ?? '').trim() || null,
    allowedChats,
    e2eUserId: e2eUserId && env.TG_ACCEPT_ONLY_ENVIRONMENT === 'sandbox' ? e2eUserId : null,
    chatProfiles,
    requestTimeoutMs: num(env, 'TG_SLICE_REQUEST_TIMEOUT_MS', 5000, 100, 60000),
    routeRequestTimeoutMs: num(env, 'TG_SLICE_ROUTE_REQUEST_TIMEOUT_MS', 140000, 100, 180000),
    pollIntervalMs: num(env, 'TG_SLICE_POLL_INTERVAL_MS', 250, 10, 10000),
    batchWindowMs: num(env, 'TG_SLICE_BATCH_WINDOW_MS', 3000, 0, 60000),
    maxBatchItems: num(env, 'TG_SLICE_MAX_BATCH_ITEMS', 20, 1, 100),
    deliveryMaxAttempts: num(env, 'TG_SLICE_DELIVERY_MAX_ATTEMPTS', 6, 1, 20),
    deliveryRetryBaseMs: num(env, 'TG_SLICE_DELIVERY_RETRY_BASE_MS', 1000, 100, 60000),
    eventTransport: transport,
    productionMode,
    maxTurns: num(env, 'TG_SLICE_MAX_TURNS', 32, 1, 512),
  };
}

export function chatAllowed(config, chatId) {
  if (config.productionMode) return true;
  return config.openSandbox === true || config.allowedChats.includes(String(chatId));
}

/** Which auth scheme the slice uses — for logs and reports (never the key itself). */
export function authScheme(config) {
  if (config.principalSignature) return 'x-principal+signature';
  return config.apiKey ? 'x-principal+bearer' : 'x-principal';
}

export default { readTgSliceConfig, authScheme, PRODUCTION_BOT_USERNAMES, TgSliceConfigError };
