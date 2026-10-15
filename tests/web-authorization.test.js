import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/telegram.js', () => ({
  sendMessage: vi.fn().mockResolvedValue({ ok: true }),
  sendMessageWithKeyboard: vi.fn().mockResolvedValue({ ok: true }),
  pinChatMessage: vi.fn(),
  unpinChatMessage: vi.fn(),
  deleteMessage: vi.fn(),
}));
vi.mock('../src/handlers/message.js', () => ({ handleMessage: vi.fn() }));

import { cmdWebAuthorization } from '../src/handlers/commands.js';
import { sendMessage } from '../src/lib/telegram.js';

const realFetch = globalThis.fetch;
const envFor = (session = { username: 'alice', name: 'Alice', telegramUserId: 123 }) => ({
  BOT_TOKEN: 'test-bot-token', IDENTITY_API_URL: 'https://identity.example', IDENTITY_ISSUER_TOKEN: 'test-issuer-secret',
  SESSIONS: { get: async () => JSON.stringify(session) },
});

describe('/web_authorization', () => {
  beforeEach(() => { vi.clearAllMocks(); globalThis.fetch = realFetch; });

  it('issues a code only for the already authenticated Telegram account and sends it privately', async () => {
    let call;
    globalThis.fetch = async (url, init) => {
      call = { url: String(url), init };
      return Response.json({ code: '23456789ABCD', expires_in_seconds: 600 }, { status: 201 });
    };
    await cmdWebAuthorization({
      chat: { id: 123, type: 'private' }, from: { id: 123, username: 'alice_tg' }, text: '/web_authorization',
    }, envFor());
    expect(call.url).toBe('https://identity.example/v1/links/telegram/challenges');
    expect(call.init.headers.authorization).toBe('Bearer test-issuer-secret');
    expect(JSON.parse(call.init.body)).toEqual({ telegram_user_id: '123', telegram_username: 'alice_tg', agent_username: 'alice' });
    expect(sendMessage).toHaveBeenCalledWith('test-bot-token', 123, expect.stringContaining('23456789ABCD'), expect.anything());
  });

  it('never sends an authorization code to a group', async () => {
    globalThis.fetch = vi.fn();
    await cmdWebAuthorization({
      chat: { id: -1001, type: 'supergroup' }, from: { id: 123 }, text: '/web_authorization',
    }, envFor());
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith('test-bot-token', -1001, expect.not.stringContaining('23456789ABCD'), expect.anything());
  });

  it('rejects a session belonging to a different Telegram ID', async () => {
    globalThis.fetch = vi.fn();
    await cmdWebAuthorization({
      chat: { id: 123, type: 'private' }, from: { id: 999 }, text: '/web_authorization',
    }, envFor());
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith('test-bot-token', 123, expect.stringContaining('Сначала войди'), expect.anything());
  });

  it('does not print an invalid upstream response', async () => {
    globalThis.fetch = async () => Response.json({ code: 'malicious-reflected-secret' }, { status: 201 });
    await cmdWebAuthorization({
      chat: { id: 123, type: 'private' }, from: { id: 123 }, text: '/web_authorization',
    }, envFor());
    expect(sendMessage).toHaveBeenCalledWith('test-bot-token', 123, expect.not.stringContaining('malicious-reflected-secret'), expect.anything());
  });
});
