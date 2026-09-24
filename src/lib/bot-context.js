// Per-request bot identity (epic trained-assist-agent#1342, Phase 1).
//
// Goal: one Worker serves N bots. The bot is resolved from the TRANSPORT —
// the webhook path /webhook/<botId> or the X-Telegram-Bot-Api-Secret-Token
// header — never from message text or LLM arguments.
//
// Registry: optional `BOTS` var (JSON array), mirroring bots.registry in
// trained-assist-agent/infra/env-manifest.json:
//   [{ "botId": "recruiter", "audience": "recruiter", "username": "super_recruiter_assistant_bot",
//      "tokenBinding": "BOT_TOKEN_RECRUITER", "webhookSecretBinding": "WEBHOOK_SECRET_RECRUITER" }]
// Tokens/secrets stay in Worker secrets; the registry only names the bindings.
//
// Without BOTS (today's per-env deploys) the context is exactly the legacy env:
// BOT_TOKEN / SESSION_NAMESPACE / BOT_USERNAME / TELEGRAM_WEBHOOK_SECRET — so the
// derived env is byte-identical and nothing changes.
import { resolveAudience } from './audience.js';

export function parseBots(env) {
  const raw = env?.BOTS;
  if (!raw) return [];
  const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!Array.isArray(list)) throw new Error('BOTS must be a JSON array');
  return list;
}

function legacyContext(env) {
  return {
    botId: null,
    token: env.BOT_TOKEN,
    audience: resolveAudience(env),
    username: env.BOT_USERNAME,
    webhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
  };
}

function registryContext(env, bot) {
  return {
    botId: bot.botId,
    token: env[bot.tokenBinding],
    audience: bot.audience || 'default',
    username: bot.username,
    webhookSecret: bot.webhookSecretBinding ? env[bot.webhookSecretBinding] : undefined,
  };
}

// Returns the bot context, or null when the request names a bot we don't serve.
//   pathBotId — the :botId path param (undefined on the legacy /webhook route).
export function resolveBotContext(env, { pathBotId, secretHeader } = {}) {
  const bots = parseBots(env);
  if (pathBotId !== undefined) {
    const bot = bots.find(b => b.botId === pathBotId);
    return bot ? registryContext(env, bot) : null;
  }
  // Legacy /webhook: a registry bot may still be identified by its own secret.
  if (secretHeader) {
    const bot = bots.find(b => b.webhookSecretBinding && env[b.webhookSecretBinding] === secretHeader);
    if (bot) return registryContext(env, bot);
  }
  return legacyContext(env);
}

// The env the rest of the Worker sees for this update. Keeps all existing
// env.BOT_TOKEN / SESSION_NAMESPACE / BOT_USERNAME call sites untouched.
export function envForBot(env, ctx) {
  if (!ctx.botId) return env;
  const out = { ...env, BOT_TOKEN: ctx.token, BOT_USERNAME: ctx.username };
  if (ctx.audience && ctx.audience !== 'default') out.SESSION_NAMESPACE = ctx.audience;
  else delete out.SESSION_NAMESPACE;
  return out;
}
