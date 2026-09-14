import { describe, it, expect, vi, beforeEach } from 'vitest';

// The owner's complaint: a freshly-added bot gives "ноль реакции, старт только
// реплаем" — it sits silent and the user has to guess how to talk to it. The fix:
// the moment the bot is added to a group (Telegram `new_chat_members` service
// message that includes the bot itself), greet and spell out /login + /all_on,
// instead of the old branch that just cleared the cache and returned.
//
// These tests lock:
//   1. bot added → a greeting is sent, mentioning /login and /all_on.
//   2. only a HUMAN joins → no greeting (no false chatter).
//   3. botWasAddedToGroup is a pure, case-insensitive username match.

vi.mock('../src/handlers/message.js', () => ({ handleMessage: vi.fn() }));
vi.mock('../src/handlers/commands.js', async (orig) => {
  const mod = await orig();
  return { ...mod, isAdminForwardedCommand: () => false };
});
vi.mock('../src/handlers/user-mgmt.js', () => ({ handleUserMgmt: vi.fn(), isUserMgmtCommand: () => false }));
vi.mock('../src/handlers/callbacks.js', () => ({ handleCallbackQuery: vi.fn() }));
vi.mock('../src/lib/kv.js', () => ({
  getSession: vi.fn(async () => null),
  setSession: vi.fn(),
  deleteSession: vi.fn(),
  getOrCreateMappedSession: vi.fn(async () => ({ allMsgMode: false })),
  getChatProfileFromMapping: () => null,
  getUser: vi.fn(async () => null),
  listUsernames: vi.fn(async () => []),
}));
vi.mock('../src/lib/telegram.js', () => ({
  sendMessage: vi.fn(async () => ({ ok: true, result: { message_id: 1 } })),
  sendMessageWithKeyboard: vi.fn(async () => ({ ok: true })),
  pinChatMessage: vi.fn(), unpinChatMessage: vi.fn(), deleteMessage: vi.fn(),
}));

import { dispatchInner } from '../src/index.js';
import { sendMessage } from '../src/lib/telegram.js';
import { botWasAddedToGroup, groupWelcomeText } from '../src/group-routing.js';

const BOT = 'super_personal_assistant_bot';
const now = () => Math.floor(Date.now() / 1000);
const env = () => ({
  BOT_TOKEN: 't',
  BOT_USERNAME: BOT,
  SESSIONS: { get: vi.fn(async () => null), put: vi.fn(), delete: vi.fn(async () => {}) },
});

beforeEach(() => vi.clearAllMocks());

describe('greeting when the bot is added to a group', () => {
  it('1. bot among new_chat_members → greets with /login and /all_on', async () => {
    const e = env();
    await dispatchInner({
      message: {
        chat: { id: -1001, type: 'supergroup' }, date: now(),
        new_chat_members: [{ id: 42, is_bot: true, username: BOT }],
      },
    }, e);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const text = sendMessage.mock.calls[0][2];
    expect(text).toContain('/login');
    expect(text).toContain('/all_on');
    expect(e.SESSIONS.delete).toHaveBeenCalledWith('mc:-1001'); // cache still invalidated
  });

  it('2. only a human joins → no greeting (no false chatter)', async () => {
    const e = env();
    await dispatchInner({
      message: {
        chat: { id: -1001, type: 'supergroup' }, date: now(),
        new_chat_members: [{ id: 7, is_bot: false, username: 'alice' }],
      },
    }, e);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(e.SESSIONS.delete).toHaveBeenCalledWith('mc:-1001'); // cache still invalidated
  });
});

describe('botWasAddedToGroup (pure)', () => {
  it('matches the bot by username, case-insensitive', () => {
    expect(botWasAddedToGroup({ new_chat_members: [{ username: 'Super_Personal_Assistant_Bot' }] }, BOT)).toBe(true);
  });
  it('false when the bot is not among joiners', () => {
    expect(botWasAddedToGroup({ new_chat_members: [{ username: 'bob' }] }, BOT)).toBe(false);
  });
  it('false when there is no new_chat_members', () => {
    expect(botWasAddedToGroup({ text: 'hi' }, BOT)).toBe(false);
  });
  it('welcome text names the bot mention', () => {
    expect(groupWelcomeText(BOT)).toContain('@' + BOT);
  });
});
