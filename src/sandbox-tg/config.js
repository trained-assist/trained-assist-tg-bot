// Configuration of the Telegram sandbox slice: ONLY from the environment.
//
// No URL, no key, no token is read from the repo, from a config file or from
// the production worker. The slice is a separate Worker (wrangler.sandbox-tg.toml)
// with its own bindings, its own bot and its own origins; the production worker
// (src/index.js) is untouched.
//
// Fail-closed rules:
//  - the sandbox refuses to start if the configured bot identity is one of the
//    production identities (a misconfigured sandbox must never touch prod);
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
  const botUsername = requireVar(env, 'TG_SANDBOX_BOT_USERNAME').replace(/^@/, '');
  if (PRODUCTION_BOT_USERNAMES.includes(botUsername)) {
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
  const chatProfiles = {};
  for (const entry of parseChatList(env['TG_SLICE_CHAT_PROFILES'])) {
    const [chatId, profileId] = entry.split(':').map(part => part.trim());
    if (chatId && profileId) chatProfiles[chatId] = profileId;
  }
  return {
    botUsername,
    botToken: requireVar(env, 'TG_SANDBOX_BOT_TOKEN'),
    controlPlaneUrl: stripTrailingSlash(requireVar(env, 'CONTROL_PLANE_URL')),
    principalId: requireVar(env, 'CONTROL_PLANE_PRINCIPAL'),
    principalSignature: String(env['CONTROL_PLANE_PRINCIPAL_SIGNATURE'] ?? '').trim() || null,
    profileId: requireVar(env, 'CONTROL_PLANE_PROFILE'),
    apiKey: String(env['CONTROL_PLANE_API_KEY'] ?? '').trim() || null,
    sessionId: String(env['CONTROL_PLANE_SESSION_ID'] ?? '').trim() || null,
    telegramApiBase: stripTrailingSlash(String(env['TELEGRAM_API_BASE'] ?? 'https://api.telegram.org')),
    webhookSecret: String(env['TELEGRAM_WEBHOOK_SECRET'] ?? '').trim() || null,
    allowedChats,
    chatProfiles,
    requestTimeoutMs: num(env, 'TG_SLICE_REQUEST_TIMEOUT_MS', 5000, 100, 60000),
    pollIntervalMs: num(env, 'TG_SLICE_POLL_INTERVAL_MS', 250, 10, 10000),
    batchWindowMs: num(env, 'TG_SLICE_BATCH_WINDOW_MS', 3000, 0, 60000),
    maxBatchItems: num(env, 'TG_SLICE_MAX_BATCH_ITEMS', 20, 1, 100),
    deliveryMaxAttempts: num(env, 'TG_SLICE_DELIVERY_MAX_ATTEMPTS', 6, 1, 20),
    deliveryRetryBaseMs: num(env, 'TG_SLICE_DELIVERY_RETRY_BASE_MS', 1000, 100, 60000),
    eventTransport: transport,
    maxTurns: num(env, 'TG_SLICE_MAX_TURNS', 32, 1, 512),
  };
}

/** Which auth scheme the slice uses — for logs and reports (never the key itself). */
export function authScheme(config) {
  if (config.principalSignature) return 'x-principal+signature';
  return config.apiKey ? 'x-principal+bearer' : 'x-principal';
}

export default { readTgSliceConfig, authScheme, PRODUCTION_BOT_USERNAMES, TgSliceConfigError };
