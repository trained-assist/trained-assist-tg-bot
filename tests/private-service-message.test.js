import { describe, it, expect, vi, beforeEach } from 'vitest';

// Owner report: bot pins its own "📌 Контекст" message in a private chat →
// Telegram delivers that as a service update (msg.pinned_message set, no
// text/voice/photo/document) → it fell through to handleMessage's final else
// and replied "⚠️ Не могу обработать этот тип сообщения" — noise the human
// never sent. The group branch already gates ambient messages on hasContent();
// the private branch had no equivalent gate. Lock: a content-less private
// update is dropped silently, same as the group path.

const handleMessage = vi.fn();
vi.mock('../src/handlers/message.js', () => ({ handleMessage: (...a) => handleMessage(...a) }));
vi.mock('../src/handlers/commands.js', () => ({ handleCommand: vi.fn(), isAdminForwardedCommand: () => false }));
vi.mock('../src/handlers/user-mgmt.js', () => ({ handleUserMgmt: vi.fn(), isUserMgmtCommand: () => false }));
vi.mock('../src/handlers/callbacks.js', () => ({ handleCallbackQuery: vi.fn() }));
vi.mock('../src/lib/kv.js', () => ({ getSession: vi.fn(async () => ({})), setSession: vi.fn() }));
vi.mock('../src/lib/telegram.js', () => ({
  sendMessage: vi.fn(async () => ({ ok: true, result: { message_id: 1 } })),
  sendMessageWithKeyboard: vi.fn(async () => ({ ok: true })),
}));

import { dispatchInner } from '../src/index.js';
import { sendMessage } from '../src/lib/telegram.js';

const now = () => Math.floor(Date.now() / 1000);
const env = () => ({ BOT_TOKEN: 't', SESSIONS: {} });

beforeEach(() => vi.clearAllMocks());

describe('private chat — content-less service updates', () => {
  it('pinned_message notification is dropped silently, not routed to handleMessage', async () => {
    await dispatchInner({
      message: {
        chat: { id: 99, type: 'private' }, date: now(), from: { id: 99 },
        pinned_message: { message_id: 5, text: '📌 Контекст' },
      },
    }, env());
    expect(handleMessage).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('a real text message still reaches routing as before', async () => {
    await dispatchInner({
      message: { chat: { id: 99, type: 'private' }, date: now(), from: { id: 99 }, text: 'продолжай' },
    }, env());
    expect(handleMessage).toHaveBeenCalledTimes(1);
  });
});
