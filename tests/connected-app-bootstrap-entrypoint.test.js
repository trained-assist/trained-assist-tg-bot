import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/telegram.js', async importOriginal => {
  const original = await importOriginal();
  return { ...original, sendMessage: vi.fn(async () => ({ ok: true })) };
});
import worker from '../src/index.js';
import { sendMessage } from '../src/lib/telegram.js';
import { isConnectCommand } from '../src/lib/connected-app-bootstrap.js';

const gatewayKey = 'telegram-gateway-test-key-with-thirty-two-chars';
const now = () => Math.floor(Date.now() / 1000);
const env = () => ({ TELEGRAM_WEBHOOK_SECRET: 'signed-secret', BOT_USERNAME: 'test_bot',
  BOT_TOKEN: 'unused-bot-token', CONNECTED_APP_TELEGRAM_CONNECT_ENABLED: 'true',
  CONNECTED_APP_BOOTSTRAP_BOT_ID: 'test_bot',
  CONNECTED_APP_CONTROL_PLANE_URL: 'https://control.example.invalid',
  CONNECTED_APP_TELEGRAM_GATEWAY_KEY: gatewayKey });
const update = (overrides = {}) => ({ update_id: 50001,
  message: { message_id: 11, date: now(), chat: { id: 12345, type: 'private' },
    from: { id: 12345 }, text: '/connect', ...overrides },
});
async function webhook(state, payload = update(), secret = 'signed-secret', path = '/webhook') {
  const jobs = [];
  const response = await worker.fetch(new Request(`https://gateway.example.invalid${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json',
      ...(secret ? { 'x-telegram-bot-api-secret-token': secret } : {}) },
    body: JSON.stringify(payload),
  }), state, { waitUntil: promise => jobs.push(promise) });
  await Promise.all(jobs);
  return { response, jobs };
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('signed Telegram /connect first-party bootstrap ingress', () => {
  it('rejects an unsigned or wrong-secret update before any CP call', async () => {
    const call = vi.fn(); vi.stubGlobal('fetch', call);
    expect((await webhook(env(), update(), null)).response.status).toBe(401);
    expect((await webhook(env(), update(), 'wrong')).response.status).toBe(401);
    expect(call).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('keeps /connect away from the old Agent while the feature is off', async () => {
    const call = vi.fn(); vi.stubGlobal('fetch', call);
    const state = env(); delete state.CONNECTED_APP_TELEGRAM_CONNECT_ENABLED;
    expect((await webhook(state)).response.status).toBe(200);
    expect(call).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith('unused-bot-token', 12345, 'Веб-вход пока не включён.');
  });

  it('passes only provider-verified private actor identifiers to CP', async () => {
    const call = vi.fn(async () => Response.json({ accepted: true, duplicate: false }, { status: 202 }));
    vi.stubGlobal('fetch', call);
    const result = await webhook(env());
    expect(result.response.status).toBe(200);
    expect(result.jobs).toHaveLength(1);
    expect(call).toHaveBeenCalledTimes(1);
    const [target, options] = call.mock.calls[0];
    expect(new URL(target).pathname).toBe('/v1/connected-app-bootstrap/telegram/start');
    expect(options.redirect).toBe('manual');
    expect(options.headers.authorization).toBe(`Bearer ${gatewayKey}`);
    expect(JSON.parse(options.body)).toEqual({ botId: 'test_bot', updateId: '50001',
      telegramUserId: '12345', chatId: 12345, chatType: 'private' });
    expect(sendMessage).not.toHaveBeenCalled();
    await webhook(env());
    expect(call).toHaveBeenCalledTimes(2); // CP owns durable update dedup.
  });

  it('never calls CP for a group, mismatched actor or stale update', async () => {
    const call = vi.fn(); vi.stubGlobal('fetch', call);
    await webhook(env(), update({ chat: { id: -100, type: 'group' }, from: { id: 12345 } }));
    await webhook(env(), update({ from: { id: 99999 } }));
    await webhook(env(), update({ date: now() - 301 }));
    expect(call).not.toHaveBeenCalled();
  });

  it('uses the registry bot ID and excludes a command addressed to another bot', async () => {
    const state = { ...env(), BOTS: JSON.stringify([{ botId: 'recruiter', audience: 'recruiter',
      username: 'recruiter_bot', tokenBinding: 'BOT_TOKEN_RECRUITER', webhookSecretBinding: 'WEBHOOK_SECRET_RECRUITER' }]),
    BOT_TOKEN_RECRUITER: 'unused-recruiter-token', WEBHOOK_SECRET_RECRUITER: 'recruiter-secret' };
    const call = vi.fn(async () => Response.json({ accepted: true }, { status: 202 }));
    vi.stubGlobal('fetch', call);
    await webhook(state, update({ text: '/connect@recruiter_bot' }), 'recruiter-secret', '/webhook/recruiter');
    expect(JSON.parse(call.mock.calls[0][1].body).botId).toBe('recruiter');
    expect(isConnectCommand(update({ text: '/connect@other_bot' }).message, 'recruiter_bot')).toBe(false);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('keeps a missing or unavailable CP binding from exposing a link or token', async () => {
    const call = vi.fn(async () => Response.json({ error: 'forbidden' }, { status: 403 }));
    vi.stubGlobal('fetch', call);
    await webhook(env());
    expect(sendMessage).toHaveBeenCalledWith('unused-bot-token', 12345,
      'Ссылка пока недоступна. Попробуйте /connect ещё раз.');
    expect(JSON.stringify(sendMessage.mock.calls)).not.toContain('http');
  });
});
