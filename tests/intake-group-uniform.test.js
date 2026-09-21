import { describe, it, expect, vi, beforeEach } from 'vitest';

// Group admission differs; admitted content uses the same intake as private chats.

const handleMessage = vi.fn();
vi.mock('../src/handlers/message.js', () => ({ handleMessage: (...a) => handleMessage(...a) }));
vi.mock('../src/handlers/commands.js', async (orig) => {
  const mod = await orig();
  return { ...mod, isAdminForwardedCommand: () => false };
});
vi.mock('../src/handlers/user-mgmt.js', () => ({ handleUserMgmt: vi.fn(), isUserMgmtCommand: () => false }));
vi.mock('../src/handlers/callbacks.js', () => ({ handleCallbackQuery: vi.fn() }));

// KV + auth + telegram: capture setSession. getSession is the single session read now
// (no CHAT_MAPPINGS re-derivation) — a mutable `currentSession` lets each test set what
// the store holds: null for the login test, an allMsgMode session for the ambient test.
const setSession = vi.fn();
let currentSession = null;
vi.mock('../src/lib/kv.js', () => ({
  getSession: vi.fn(async () => currentSession),
  setSession: (...a) => setSession(...a),
  deleteSession: vi.fn(),
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

beforeEach(() => { vi.clearAllMocks(); currentSession = null; });

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
    currentSession = { username: 'owner', allMsgMode: true }; // logged-in group, allMsgMode on
    await dispatchInner(groupMsg({ text: 'первая мысль' }), env);
    expect(handleMessage).not.toHaveBeenCalled();          // not launched per-message
    expect(_appended).toHaveLength(1);                     // it reached the intake buffer
    // The exact format the agent-side buffer consumes: {text, msg, flush:false}.
    expect(_appended[0]).toMatchObject({ text: 'первая мысль', flush: false });
    expect(_appended[0].msg.chat.id).toBe(-1001);
  });

  it('3. a reply-to-bot accumulates and pins the continuation', async () => {
    const { env, _appended } = makeEnv();
    currentSession = { lastSessionId: 'original', projectId: 'p1' };
    await dispatchInner(groupMsg({ text: 'да', reply_to_message: { from: { username: 'super_personal_assistant_bot' } } }), env);
    expect(_appended).toHaveLength(1);
    expect(_appended[0].msg.intakeRoute).toMatchObject({ sessionId: 'original', projectId: 'p1' });
    expect(handleMessage).not.toHaveBeenCalled();
  });
});

const payloads = [
  { text: 'подробности' }, { text: undefined, voice: { file_id: 'v' } },
  { text: undefined, audio: { file_id: 'a' } },
  { text: undefined, photo: [{ file_id: 'p' }], caption: 'снимок' },
  { text: undefined, document: { file_id: 'd' }, caption: 'файл' },
];

describe('private/group admission parity for every supported attachment', () => {
  for (const payload of payloads) {
    it(`routes ${Object.keys(payload).join('/')} identically after admission`, async () => {
      for (const mode of ['private', 'small', 'all_on', 'reply', 'mention']) {
        const { env, _appended } = makeEnv();
        currentSession = { allMsgMode: mode === 'all_on', lastSessionId: 'original', projectId: 'p1' };
        env.SESSIONS.get.mockResolvedValue({ count: mode === 'small' ? 2 : 50, ts: Date.now() });
        const update = groupMsg({ ...payload });
        if (mode === 'private') update.message.chat = { id: 7, type: 'private' };
        if (mode === 'reply') update.message.reply_to_message = { from: { username: env.BOT_USERNAME } };
        if (mode === 'mention') {
          const key = payload.text ? 'text' : 'caption';
          update.message[key] = `@${env.BOT_USERNAME} ${update.message[key] || ''}`;
        }
        await dispatchInner(update, env);
        expect(_appended, mode).toHaveLength(1);
        expect(_appended[0].flush, mode).toBe(false);
        for (const key of ['voice', 'audio', 'photo', 'document']) {
          if (payload[key]) expect(_appended[0].msg[key]).toEqual(payload[key]);
        }
      }
      expect(handleMessage).not.toHaveBeenCalled();
    });

    it(`ignores human-to-human ${Object.keys(payload).join('/')} in all_off large groups`, async () => {
      const { env, _appended } = makeEnv();
      currentSession = { allMsgMode: false };
      env.SESSIONS.get.mockResolvedValue({ count: 3, ts: Date.now() });
      await dispatchInner(groupMsg(payload), env);
      await dispatchInner(groupMsg({ ...payload, reply_to_message: { from: { username: 'another_human' } } }), env);
      expect(_appended).toHaveLength(0);
      expect(handleMessage).not.toHaveBeenCalled();
    });
  }
});
