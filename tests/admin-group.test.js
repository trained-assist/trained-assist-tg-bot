import { describe, it, expect, vi, beforeEach } from 'vitest';

// Incident 2026-09-24: admin chat was upgraded to a supergroup (-4312117839 →
// -1004312117839); ADMIN_GROUP_ID kept the old id, /adduser answered
// "❓ Неизвестная команда". Lock: both id forms route to user-mgmt, and an
// admin-only command in any other chat explains itself instead.

const handleUserMgmt = vi.fn();
const handleCommand = vi.fn();
vi.mock('../src/handlers/message.js', () => ({ handleMessage: vi.fn() }));
vi.mock('../src/handlers/commands.js', () => ({ handleCommand: (...a) => handleCommand(...a), isAdminForwardedCommand: () => false }));
vi.mock('../src/handlers/user-mgmt.js', () => ({
  handleUserMgmt: (...a) => handleUserMgmt(...a),
  isUserMgmtCommand: (t) => /^\/(adduser|um|listusers)/.test(t),
}));
vi.mock('../src/handlers/callbacks.js', () => ({ handleCallbackQuery: vi.fn() }));
vi.mock('../src/lib/kv.js', () => ({ getSession: vi.fn(async () => ({})), setSession: vi.fn() }));
vi.mock('../src/lib/telegram.js', () => ({
  sendMessage: vi.fn(async () => ({ ok: true, result: { message_id: 1 } })),
  sendMessageWithKeyboard: vi.fn(async () => ({ ok: true })),
}));

import { dispatchInner } from '../src/index.js';
import { sendMessage } from '../src/lib/telegram.js';
import { isAdminGroupChat, isAdminOnlyCommand } from '../src/lib/admin-group.js';

const now = () => Math.floor(Date.now() / 1000);
const env = (ADMIN_GROUP_ID = '-4312117839') => ({ BOT_TOKEN: 't', BOT_USERNAME: 'bot', SESSIONS: { delete: vi.fn() }, ADMIN_GROUP_ID });
const msg = (id, type, text) => ({ message: { chat: { id, type }, date: now(), from: { id: 1 }, text } });

beforeEach(() => vi.clearAllMocks());

describe('isAdminGroupChat', () => {
  it('matches basic-group id and its supergroup form both ways', () => {
    expect(isAdminGroupChat(-4312117839, '-4312117839')).toBe(true);
    expect(isAdminGroupChat(-1004312117839, '-4312117839')).toBe(true);
    expect(isAdminGroupChat(-4312117839, '-1004312117839')).toBe(true);
    expect(isAdminGroupChat(-1004312117839, ' -1004312117839\n')).toBe(true);
  });
  it('accepts a comma-separated list', () => {
    expect(isAdminGroupChat(-555, '-4312117839, -555')).toBe(true);
  });
  it('rejects other chats, unset secret and positive (private) ids', () => {
    expect(isAdminGroupChat(-5039573935, '-4312117839')).toBe(false);
    expect(isAdminGroupChat(-4312117839, undefined)).toBe(false);
    expect(isAdminGroupChat(-4312117839, '')).toBe(false);
    expect(isAdminGroupChat(4312117839, '-4312117839')).toBe(false);
  });
  it('isAdminOnlyCommand is exact-token', () => {
    expect(isAdminOnlyCommand('/adduser x Y')).toBe(true);
    expect(isAdminOnlyCommand('/adduser@bot x')).toBe(true);
    expect(isAdminOnlyCommand('/addusers')).toBe(false);
    expect(isAdminOnlyCommand('что-то /adduser x')).toBe(false);
  });
});

describe('dispatch', () => {
  it('/adduser from the migrated supergroup reaches user-mgmt', async () => {
    await dispatchInner(msg(-1004312117839, 'supergroup', '/adduser vova-servles-com Trained Assist'), env());
    expect(handleUserMgmt).toHaveBeenCalledTimes(1);
    expect(handleCommand).not.toHaveBeenCalled();
  });

  it('/adduser elsewhere explains the admin-chat rule instead of "Неизвестная команда"', async () => {
    await dispatchInner(msg(-5039573935, 'group', '/adduser x'), env());
    expect(handleUserMgmt).not.toHaveBeenCalled();
    expect(handleCommand).not.toHaveBeenCalled();
    expect(sendMessage.mock.calls[0][2]).toMatch(/только в админ-чате.*-5039573935/);
  });

  it('ordinary commands in other groups are untouched', async () => {
    await dispatchInner(msg(-5039573935, 'group', '/start'), env());
    expect(handleCommand).toHaveBeenCalledTimes(1);
  });
});
