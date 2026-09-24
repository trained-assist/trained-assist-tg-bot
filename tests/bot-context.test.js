// Epic trained-assist-agent#1342 Phase 1 — bot identity from the transport.
import { describe, it, expect } from 'vitest';
import { resolveBotContext, envForBot } from '../src/lib/bot-context.js';

const legacy = { BOT_TOKEN: 'classic', BOT_USERNAME: 'main_bot', SESSIONS: {} };
const multi = {
  ...legacy,
  BOT_TOKEN_RECRUITER: 'rec-token', WEBHOOK_SECRET_RECRUITER: 'rec-secret',
  BOTS: JSON.stringify([{ botId: 'recruiter', audience: 'recruiter', username: 'rec_bot',
    tokenBinding: 'BOT_TOKEN_RECRUITER', webhookSecretBinding: 'WEBHOOK_SECRET_RECRUITER' }]),
};

describe('resolveBotContext', () => {
  it('legacy /webhook without BOTS: env passes through unchanged', () => {
    const ctx = resolveBotContext(legacy, {});
    expect(ctx).toMatchObject({ botId: null, token: 'classic', audience: 'default', username: 'main_bot' });
    expect(envForBot(legacy, ctx)).toBe(legacy);
  });
  it('legacy per-env namespace keeps its audience', () => {
    const env = { ...legacy, SESSION_NAMESPACE: 'freelance', TELEGRAM_WEBHOOK_SECRET: 's' };
    expect(resolveBotContext(env, {})).toMatchObject({ audience: 'freelance', webhookSecret: 's' });
  });
  it('/webhook/:botId resolves token, audience and secret from the registry', () => {
    const ctx = resolveBotContext(multi, { pathBotId: 'recruiter' });
    expect(ctx).toMatchObject({ botId: 'recruiter', token: 'rec-token', audience: 'recruiter', webhookSecret: 'rec-secret' });
    const env = envForBot(multi, ctx);
    expect(env).toMatchObject({ BOT_TOKEN: 'rec-token', SESSION_NAMESPACE: 'recruiter', BOT_USERNAME: 'rec_bot' });
    expect(multi.BOT_TOKEN).toBe('classic');
  });
  it('unknown botId in the path is rejected (null), never falls back to the default bot', () => {
    expect(resolveBotContext(multi, { pathBotId: 'nope' })).toBeNull();
    expect(resolveBotContext(legacy, { pathBotId: 'recruiter' })).toBeNull();
  });
  it('legacy route identifies a registry bot by its own secret header', () => {
    expect(resolveBotContext(multi, { secretHeader: 'rec-secret' }).botId).toBe('recruiter');
    expect(resolveBotContext(multi, { secretHeader: 'other' }).botId).toBeNull();
  });
  it('a default-audience registry bot drops any inherited SESSION_NAMESPACE', () => {
    const env = { ...multi, SESSION_NAMESPACE: 'recruiter', BOTS: JSON.stringify([{ botId: 'main', tokenBinding: 'BOT_TOKEN' }]) };
    expect(envForBot(env, resolveBotContext(env, { pathBotId: 'main' })).SESSION_NAMESPACE).toBeUndefined();
  });
});
