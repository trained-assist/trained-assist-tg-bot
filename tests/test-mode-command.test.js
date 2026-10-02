import { describe, it, expect, vi, beforeEach } from 'vitest';

// G7 — /test_mode (DESIGN R11): только чтение; из админ-группы → статус,
// из чужого чата → adminOnlyHint. Включение/выключение — правка [vars].

vi.mock('../src/handlers/message.js', () => ({ handleMessage: vi.fn(), processDueRetries: vi.fn() }));
vi.mock('../src/handlers/user-mgmt.js', () => ({ handleUserMgmt: vi.fn(), isUserMgmtCommand: () => false }));
vi.mock('../src/handlers/callbacks.js', () => ({ handleCallbackQuery: vi.fn() }));

import { dispatchInner } from '../src/index.js';
import { handleCommand } from '../src/handlers/commands.js';
import { isAdminOnlyCommand, isAdminLocalCommand } from '../src/lib/admin-group.js';
import { sendMessage } from '../src/lib/telegram.js';

vi.mock('../src/lib/telegram.js', () => ({
  sendMessage: vi.fn(async () => ({ ok: true, result: { message_id: 1 } })),
  sendMessageWithKeyboard: vi.fn(async () => ({ ok: true })),
  ensureCommandsRegisteredOnce: vi.fn(),
  getRegisteredCommands: vi.fn(async () => ({ ok: true, result: [] })),
  pinChatMessage: vi.fn(),
  unpinChatMessage: vi.fn(),
  deleteMessage: vi.fn(),
  editMessage: vi.fn(),
  answerCallbackQuery: vi.fn(),
  sendDocument: vi.fn(),
  editMessageReplyMarkup: vi.fn(),
}));

const now = () => Math.floor(Date.now() / 1000);
const envOf = (extra = {}) => ({
  BOT_TOKEN: 't', BOT_USERNAME: 'bot', ADMIN_GROUP_ID: '-4312117839',
  SESSIONS: { delete: vi.fn(), get: vi.fn(async () => null), put: vi.fn() },
  TEST_CHAT_IDS: '',
  ...extra,
});
const msg = (id, type, text) => ({ message: { chat: { id, type }, date: now(), from: { id: 1 }, text } });

beforeEach(() => vi.clearAllMocks());

describe('реестр: /test_mode — local + adminOnly', () => {
  it('isAdminLocalCommand / isAdminOnlyCommand узнают команду (включая @bot)', () => {
    expect(isAdminLocalCommand('/test_mode')).toBe(true);
    expect(isAdminLocalCommand('/test_mode@bot')).toBe(true);
    expect(isAdminLocalCommand('/test_mode now')).toBe(true);
    expect(isAdminLocalCommand('/other')).toBe(false);
    expect(isAdminOnlyCommand('/test_mode')).toBe(true);
    // существующее поведение не тронуто
    expect(isAdminOnlyCommand('/adduser x Y')).toBe(true);
    expect(isAdminOnlyCommand('/get_webpass vova')).toBe(false); // forward+adminOnly — не входит
  });
});

describe('/test_mode маршрутизация', () => {
  it('из админ-группы доходит до обработчика → статус в ответе', async () => {
    await dispatchInner(msg(-4312117839, 'group', '/test_mode'), envOf({ TEST_CHAT_IDS: '777000111' }));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const text = sendMessage.mock.calls[0][2];
    expect(text).toContain('Тестовый режим');
    expect(text).toContain('Чатов в TEST_CHAT_IDS: <b>1</b>');
  });

  it('из чужого чата → adminOnlyHint вместо статуса', async () => {
    await dispatchInner(msg(555000, 'private', '/test_mode'), envOf());
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][2]).toContain('работает только в админ-чате');
  });
});

describe('cmdTestMode — статус (только чтение)', () => {
  it('тестовый чат: число чатов в списке + «тестовый»', async () => {
    await handleCommand({ ...msg(777000111, 'private', '/test_mode').message }, envOf({ TEST_CHAT_IDS: '777000111, 555000' }));
    const text = sendMessage.mock.calls[0][2];
    expect(text).toContain('Чатов в TEST_CHAT_IDS: <b>2</b>');
    expect(text).toContain('тестовый');
  });

  it('обычный чат / режим выключен: «обычный», 0 чатов', async () => {
    await handleCommand({ ...msg(777000111, 'private', '/test_mode').message }, envOf({ TEST_CHAT_IDS: '' }));
    const text = sendMessage.mock.calls[0][2];
    expect(text).toContain('Чатов в TEST_CHAT_IDS: <b>0</b>');
    expect(text).toContain('обычный');
    expect(text).not.toContain('<b>тестовый</b>');
  });
});
