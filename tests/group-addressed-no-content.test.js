import { describe, it, expect, vi, beforeEach } from 'vitest';

// Incident 2026-09-27: in a group, a message addressed to the bot with no
// actable content (bare mention, reply-with-sticker/GIF) was routed straight to
// the agent as an EMPTY task. The agent answered 400 "missing fields" and the
// outbox surfaced «⚠️ Задача сохранена, но сервер отклонил её (HTTP 400)» to
// the user. Private chats had a content gate in index.js; the group addressed
// branch had none. Owner 2026-09-27: instead of dropping such messages in
// silence, reply with a friendly nudge («привет! я на связи. Есть задача?») so
// the person knows the bot is here. Lock: content-less addressed group messages
// get the nudge (never an EMPTY task, never silence); addressed text/media/video
// still route to the intake accumulator.

const handleMessage = vi.fn();
vi.mock('../src/handlers/message.js', () => ({ handleMessage: (...a) => handleMessage(...a) }));
vi.mock('../src/handlers/commands.js', async (orig) => {
  const mod = await orig();
  return { ...mod, isAdminForwardedCommand: () => false };
});
vi.mock('../src/handlers/user-mgmt.js', () => ({ handleUserMgmt: vi.fn(), isUserMgmtCommand: () => false }));
vi.mock('../src/handlers/callbacks.js', () => ({ handleCallbackQuery: vi.fn() }));
vi.mock('../src/lib/kv.js', () => ({
  getSession: vi.fn(async () => ({ username: 'owner', lastSessionId: 's-1' })),
  setSession: vi.fn(),
  deleteSession: vi.fn(),
}));
vi.mock('../src/lib/telegram.js', () => ({
  sendMessage: vi.fn(async () => ({ ok: true, result: { message_id: 1 } })),
  sendMessageWithKeyboard: vi.fn(async () => ({ ok: true })),
}));

import { dispatchInner } from '../src/index.js';
import { sendMessage } from '../src/lib/telegram.js';
import { noContentNudgeText } from '../src/group-routing.js';

const BOT = 'super_personal_assistant_bot';
const CHAT = -5470514035;
const now = () => Math.floor(Date.now() / 1000);

function makeEnv() {
  const stub = { fetch: vi.fn(async () => new Response('{}')) };
  return {
    env: {
      INTAKE_DEBOUNCE: 'on',
      BOT_TOKEN: 't',
      BOT_USERNAME: BOT,
      INTAKE: { idFromName: (n) => n, get: () => stub },
      SESSIONS: { get: vi.fn(async () => null), put: vi.fn(), delete: vi.fn() },
    },
    stub,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('group — addressed content-less message', () => {
  it('reply-to-bot with a sticker gets the nudge, never dispatched', async () => {
    const { env } = makeEnv();
    await dispatchInner({
      message: {
        chat: { id: CHAT, type: 'supergroup' }, date: now(), message_id: 1, from: { id: 1, username: 'leggent' },
        reply_to_message: { message_id: 10, from: { username: BOT }, text: 'спроси что-нибудь' },
        sticker: { file_id: 'sticker1' },
      },
    }, env);
    expect(handleMessage).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith('t', CHAT, noContentNudgeText(), {});
  });

  it('bare mention (@bot with nothing after it) gets the nudge, not dispatched empty', async () => {
    const { env } = makeEnv();
    await dispatchInner({
      message: { chat: { id: CHAT, type: 'supergroup' }, date: now(), message_id: 2, from: { id: 1, username: 'leggent' }, text: `@${BOT}` },
    }, env);
    expect(handleMessage).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith('t', CHAT, noContentNudgeText(), {});
  });

  it('addressed video still routes to the intake accumulator (no regression)', async () => {
    const { env, stub } = makeEnv();
    await dispatchInner({
      message: {
        chat: { id: CHAT, type: 'supergroup' }, date: now(), message_id: 3, from: { id: 1, username: 'leggent' },
        reply_to_message: { message_id: 10, from: { username: BOT }, text: 'спроси что-нибудь' },
        video: { file_id: 'v1', file_name: 'demo.mp4' },
      },
    }, env);
    expect(handleMessage).not.toHaveBeenCalled(); // accumulated, not dispatched directly
    expect(stub.fetch).toHaveBeenCalled();
    const { text } = JSON.parse(stub.fetch.mock.calls[0][1].body);
    expect(text).toBe('');
  });

  it('an addressed message with real text is accumulated (not dropped)', async () => {
    const { env, stub } = makeEnv();
    await dispatchInner({
      message: { chat: { id: CHAT, type: 'supergroup' }, date: now(), message_id: 4, from: { id: 1, username: 'leggent' }, text: `@${BOT} сделай отчёт` },
    }, env);
    expect(handleMessage).not.toHaveBeenCalled(); // accumulated, launch by ▶️
    expect(stub.fetch).toHaveBeenCalled();
    const { text } = JSON.parse(stub.fetch.mock.calls[0][1].body);
    expect(text).toBe('сделай отчёт');
  });
});