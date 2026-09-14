import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// THE PERSISTENCE SEAM (uniform login model — no CHAT_MAPPINGS).
//
// Every chat, group or private, now authenticates the SAME way: /login username
// password. There is no operator-curated "mapped" auto-session anymore. A group only
// accumulates ambient messages when allMsgMode is set — which /login auto-enables for
// groups and /all_on toggles — and that flag must survive the real KV round-trip.
//
// This suite exercises the seam the mocked suites can't: REAL kv.js against a
// Cloudflare-KV-like store. cmdLogin WRITES {allMsgMode:true}; the very next ambient
// dispatch READS it back from the same store. If it is lost, getGroupMemberCount runs,
// its fetch is stubbed to fail → 999 fail-closed → the ambient message is dropped →
// the accumulator is never appended → RED.
//
// The control locks the behaviour CHANGE: a group with no login (what used to be a
// "mapped" auto-accumulating chat) now gets ZERO reaction until someone logs in.
// ─────────────────────────────────────────────────────────────────────────────

const handleMessage = vi.fn();
vi.mock('../src/handlers/message.js', () => ({ handleMessage: (...a) => handleMessage(...a) }));
vi.mock('../src/handlers/user-mgmt.js', () => ({ handleUserMgmt: vi.fn(), isUserMgmtCommand: () => false }));
vi.mock('../src/handlers/callbacks.js', () => ({ handleCallbackQuery: vi.fn() }));
vi.mock('../src/lib/auth.js', () => ({ verifyPassword: vi.fn(async () => true) }));
vi.mock('../src/lib/telegram.js', () => ({
  sendMessage: vi.fn(async () => ({ ok: true, result: { message_id: 1 } })),
  sendMessageWithKeyboard: vi.fn(async () => ({ ok: true, result: { message_id: 2 } })),
  pinChatMessage: vi.fn(), unpinChatMessage: vi.fn(), deleteMessage: vi.fn(),
}));
// NOTE: kv.js is deliberately NOT mocked — that is the whole point.

import { dispatchInner } from '../src/index.js';
import { cmdLogin } from '../src/handlers/commands.js';

// A Map-backed store with Cloudflare KV semantics: string in / string out, with the
// `{type:'json'}` read variant getGroupMemberCount uses. One store instance is shared
// between the write (command) and the read (ambient dispatch) — exactly like prod.
function makeKV() {
  const map = new Map();
  return {
    map,
    get: vi.fn(async (key, opts) => {
      const v = map.has(key) ? map.get(key) : null;
      if (opts?.type === 'json') return v == null ? null : JSON.parse(v);
      return v;
    }),
    put: vi.fn(async (key, val) => { map.set(key, String(val)); }),
    delete: vi.fn(async (key) => { map.delete(key); }),
  };
}

const GROUP = -1001;
const now = () => Math.floor(Date.now() / 1000);

function makeEnv() {
  const appended = [];
  const intakeStub = { fetch: vi.fn(async (_url, init) => { appended.push(JSON.parse(init.body)); return new Response('{}'); }) };
  const SESSIONS = makeKV();
  const USERS = makeKV();
  // Seed the profile so real getUser + verifyPassword(mocked→true) let /login succeed.
  USERS.map.set('user:owner', JSON.stringify({ name: 'Owner', passwordHash: 'h', salt: 's' }));
  return {
    _appended: appended,
    SESSIONS,
    env: {
      INTAKE_DEBOUNCE: 'on',
      BOT_TOKEN: 't',
      BOT_USERNAME: 'super_personal_assistant_bot',
      INTAKE: { idFromName: (n) => n, get: () => intakeStub },
      SESSIONS,
      USERS,
    },
  };
}

const ambient = (text) => ({ message: { chat: { id: GROUP, type: 'supergroup' }, from: { id: 7, username: 'owner' }, date: now(), text } });

beforeEach(() => {
  vi.clearAllMocks();
  // Force the memberCount fail-closed path: if allMsgMode is lost, the ambient message
  // MUST be dropped (999), never accidentally rescued by a lucky small-group count.
  global.fetch = vi.fn(async () => { throw new Error('no network in test'); });
});

describe('allMsgMode survives the real KV round-trip (uniform login, no CHAT_MAPPINGS)', () => {
  it('/login in a group → next ambient message reaches the accumulator', async () => {
    const { env, _appended } = makeEnv();

    // WRITE side: real cmdLogin persists {allMsgMode:true} to the real SESSIONS store.
    await cmdLogin({ chat: { id: GROUP, type: 'supergroup' }, from: { id: 7 }, text: '/login owner pw' }, env);

    // READ side: real dispatchInner → real getSession reads it BACK from the same store.
    await dispatchInner(ambient('первая мысль'), env);

    expect(handleMessage).not.toHaveBeenCalled();      // not launched per-message
    expect(_appended).toHaveLength(1);                 // reached the intake buffer
    expect(_appended[0]).toMatchObject({ text: 'первая мысль', flush: false });
  });

  it('the login persisted allMsgMode:true into the shared store (the seam, asserted)', async () => {
    const { env } = makeEnv();
    await cmdLogin({ chat: { id: GROUP, type: 'supergroup' }, from: { id: 7 }, text: '/login owner pw' }, env);
    const saved = JSON.parse(env.SESSIONS.map.get(String(GROUP)));
    expect(saved.allMsgMode).toBe(true);
    expect(saved.username).toBe('owner');
  });

  it('CONTROL: a group with NO login (was the "mapped" auto-accumulate) now drops ambient', async () => {
    // Behaviour change: previously CHAT_MAPPINGS made this chat accumulate with no login
    // and no memberCount gate. Uniform model → no session, allMsgMode unset, gate bites.
    const { env, _appended } = makeEnv();
    await dispatchInner(ambient('без логина'), env);
    expect(_appended).toHaveLength(0);
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('REGRESSION LOCK: even with a stale CHAT_MAPPINGS env, a no-login group drops ambient', async () => {
    // Under the OLD code this exact input appended to the accumulator (mapping ⇒ all-msg).
    // The uniform model must IGNORE CHAT_MAPPINGS entirely → dropped. Red against old code.
    const { env, _appended } = makeEnv();
    env.CHAT_MAPPINGS = JSON.stringify({ [GROUP]: 'owner' });
    await dispatchInner(ambient('замапленная, но без логина'), env);
    expect(_appended).toHaveLength(0);
  });

  it('CONTROL: a logged-in group after /all_off drops ambient again', async () => {
    const { env, _appended } = makeEnv();
    // Simulate a session that logged in then turned all-msg off.
    env.SESSIONS.map.set(String(GROUP), JSON.stringify({ username: 'owner', name: 'Owner', allMsgMode: false }));
    await dispatchInner(ambient('после all_off'), env);
    expect(_appended).toHaveLength(0);
  });
});
