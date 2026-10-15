import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleCommand } from '../src/handlers/commands.js';
import { getSession } from '../src/lib/kv.js';

afterEach(() => vi.unstubAllGlobals());

function memoryKv() {
  const data = new Map();
  return {
    get: async key => data.get(String(key)) ?? null,
    put: async (key, value) => data.set(String(key), String(value)),
    delete: async key => data.delete(String(key)),
    data,
  };
}

describe('self-service Telegram signup deep link', () => {
  it('confirms the exact pending signup and starts a Telegram session without a password', async () => {
    const sessions = memoryKv();
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).startsWith('https://identity.example/v1/signups/telegram/complete')) {
        return Response.json({ user_id: 'usr_0123456789abcdef0123456789abcdef', nickname: 'alice', display_name: 'Alice Example', status: 'confirmed' }, { status: 201 });
      }
      return Response.json({ ok: true, result: { message_id: 1 } });
    }));
    const env = { BOT_TOKEN: 'bot-secret', IDENTITY_API_URL: 'https://identity.example', IDENTITY_ISSUER_TOKEN: 'issuer-secret', SESSIONS: sessions };
    await handleCommand({ chat: { id: 777, type: 'private' }, from: { id: 777, username: 'alice_tg' }, text: `/start signup_${'r'.repeat(43)}` }, env);

    expect(calls[0].url).toBe('https://identity.example/v1/signups/telegram/complete');
    expect(calls[0].init.headers.authorization).toBe('Bearer issuer-secret');
    expect(JSON.parse(calls[0].init.body)).toEqual({ reference: 'r'.repeat(43), telegram_user_id: '777', telegram_username: 'alice_tg' });
    await expect(getSession(sessions, 777)).resolves.toMatchObject({
      username: 'alice', name: 'Alice Example', telegramUserId: 777,
      identityUserId: 'usr_0123456789abcdef0123456789abcdef',
    });
    expect(calls[1].init.body).toContain('Telegram подтверждён');
  });

  it('refuses signup links outside the owner Telegram private chat', async () => {
    const send = vi.fn(async () => Response.json({ ok: true, result: { message_id: 1 } }));
    vi.stubGlobal('fetch', send);
    const env = { BOT_TOKEN: 'bot-secret', IDENTITY_API_URL: 'https://identity.example', IDENTITY_ISSUER_TOKEN: 'issuer-secret', SESSIONS: memoryKv() };
    await handleCommand({ chat: { id: -100, type: 'group' }, from: { id: 777 }, text: `/start signup_${'r'.repeat(43)}` }, env);
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(send.mock.calls[0][0])).toContain('api.telegram.org');
  });
});
