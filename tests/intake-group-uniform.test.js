import { describe, it, expect, vi, beforeEach } from 'vitest';

// The exact scenario the owner reported: a logged-in GROUP chat (their 2-member QA
// group) shows ZERO reaction to a plain message, and the only way to launch is a
// reply. Reason: an ambient group message must pass shouldHandleAmbient — which needs
// allMsgMode OR memberCount<=2. When getChatMemberCount can't read the count it
// fails closed (999) → the message is silently dropped, never reaching the intake
// accumulator. A reply hits the addressed-bypass, so it "works" — hence "старт только
// реплаем". The fix: /login in a group AUTO-enables allMsgMode so every message reaches
// the SAME accumulator as a private chat (uniformity), without touching the reply path.
//
// These tests lock:
//   1. /login in a group turns allMsgMode ON (was: only told the user to run /all_on).
//   2. An ambient group message then reaches the accumulator in the CORRECT format —
//      the exact {text,msg,flush} envelope the agent's intake buffer consumes.
//   3. A reply-to-bot still bypasses to handleMessage (the working path is NOT broken).

const handleMessage = vi.fn();
vi.mock('../src/handlers/message.js', () => ({ handleMessage: (...a) => handleMessage(...a) }));
vi.mock('../src/handlers/commands.js', async (orig) => {
  const mod = await orig();
  return { ...mod, isAdminForwardedCommand: () => false };
});
vi.mock('../src/handlers/user-mgmt.js', () => ({ handleUserMgmt: vi.fn(), isUserMgmtCommand: () => false }));
vi.mock('../src/handlers/callbacks.js', () => ({ handleCallbackQuery: vi.fn() }));

// KV + auth + telegram: capture setSession / getOrCreateMappedSession.
const setSession = vi.fn();
let mappedSession = { allMsgMode: true };
vi.mock('../src/lib/kv.js', () => ({
  getSession: vi.fn(async () => null),
  setSession: (...a) => setSession(...a),
  deleteSession: vi.fn(),
  getOrCreateMappedSession: vi.fn(async () => mappedSession),
  getChatProfileFromMapping: () => null,
  getUser: vi.fn(async () => ({ name: 'Owner', passwordHash: 'h', salt: 's' })),
  listUsernames: vi.fn(async () => []),
}));
vi.mock('../src/lib/auth.js', () => ({ verifyPassword: vi.fn(async () => true) }));
vi.mock('../src/lib/telegram.js', () => ({
  sendMessage: vi.fn(async () => ({ ok: true, result: { message_id: 1 } })),
  sendMessageWithKeyboard: vi.fn(async () => ({ ok: true, result: { message_id: 2 } })),
  pinChatMessage: vi.fn(), unpinChatMessage: vi.fn(), deleteMessage: vi.fn(),
}));

import { dispatchInner } from '../src/index.js';
import { cmdLogin } from '../src/handlers/commands.js';

function makeEnv() {
  const appended = [];
  const stub = { fetch: vi.fn(async (_url, init) => { appended.push(JSON.parse(init.body)); return new Response('{}'); }) };
  return {
    _appended: appended,
    env: {
      INTAKE_DEBOUNCE: 'on',
      BOT_TOKEN: 't',
      BOT_USERNAME: 'super_personal_assistant_bot',
      INTAKE: { idFromName: (n) => n, get: () => stub },
      SESSIONS: { get: vi.fn(async () => null), put: vi.fn(), delete: vi.fn() },
    },
  };
}

const now = () => Math.floor(Date.now() / 1000);
const groupMsg = (over = {}) => ({
  message: { chat: { id: -1001, type: 'supergroup' }, from: { id: 7, username: 'owner' }, date: now(), text: 'разбери задачу', ...over },
});

beforeEach(() => { vi.clearAllMocks(); mappedSession = { allMsgMode: true }; });

describe('group login → uniform intake accumulator', () => {
  it('1. /login in a group AUTO-enables allMsgMode (so ambient msgs are not dropped)', async () => {
    const { env } = makeEnv();
    await cmdLogin({ chat: { id: -1001, type: 'supergroup' }, from: { id: 7 }, text: '/login owner pw' }, env);
    expect(setSession).toHaveBeenCalledTimes(1);
    const saved = setSession.mock.calls[0][2];
    expect(saved.allMsgMode).toBe(true);
  });

  it('2. an ambient group message reaches the accumulator in the correct envelope', async () => {
    const { env, _appended } = makeEnv();
    await dispatchInner(groupMsg({ text: 'первая мысль' }), env);
    expect(handleMessage).not.toHaveBeenCalled();          // not launched per-message
    expect(_appended).toHaveLength(1);                     // it reached the intake buffer
    // The exact format the agent-side buffer consumes: {text, msg, flush:false}.
    expect(_appended[0]).toMatchObject({ text: 'первая мысль', flush: false });
    expect(_appended[0].msg.chat.id).toBe(-1001);
  });

  it('3. a reply-to-bot still bypasses to handleMessage (reply path NOT broken)', async () => {
    const { env, _appended } = makeEnv();
    await dispatchInner(groupMsg({ text: 'да', reply_to_message: { from: { username: 'super_personal_assistant_bot' } } }), env);
    expect(_appended).toHaveLength(0);
    expect(handleMessage).toHaveBeenCalledTimes(1);
  });
});
