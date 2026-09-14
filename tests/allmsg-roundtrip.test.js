import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// THE BLIND LAYER.
//
// Live complaint: `/all_on` (and `/login`, which auto-enables it) reports success,
// but the very next ambient group message gets ZERO reaction — as if allMsgMode was
// never stored. Every fix "passed the tests" yet failed in prod. Reason the tests
// never caught it: they all mock `../src/lib/kv.js` wholesale. Concretely,
// tests/intake-group-uniform.test.js proves TWO disconnected halves —
//   #1  cmdLogin CALLS setSession({allMsgMode:true})           ← the WRITE
//   #2  an ambient msg reaches the accumulator, GIVEN
//       getOrCreateMappedSession() is hardcoded → {allMsgMode:true}  ← the READ, FAKED
// Nothing verifies that what #1 writes is what #2 reads back. The persistence seam —
// JSON round-trip through a KV store AND the CHAT_MAPPINGS re-derivation in
// getOrCreateMappedSession (kv.js:26-31, the `{...session}` spread that must preserve
// allMsgMode) — is stubbed on BOTH sides, so it is the one layer no test exercises.
//
// This suite closes that gap: REAL kv.js against a Cloudflare-KV-like store, with
// CHAT_MAPPINGS set (the prod condition), driving the actual command → ambient
// round-trip. If allMsgMode is lost anywhere in that seam, getGroupMemberCount runs,
// its fetch is stubbed to fail → 999 fail-closed → the ambient message is dropped →
// the accumulator is never appended → RED.
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
import { handleCommand, cmdLogin } from '../src/handlers/commands.js';

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

function makeEnv({ mapped = true } = {}) {
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
      // Prod condition: this group is bound to a profile via CHAT_MAPPINGS, so every
      // read flows through getOrCreateMappedSession's re-derivation branch.
      ...(mapped ? { CHAT_MAPPINGS: JSON.stringify({ [GROUP]: 'owner' }) } : {}),
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

describe('allMsgMode survives the real KV round-trip (CHAT_MAPPINGS prod path)', () => {
  it('/login in a mapped group → next ambient message reaches the accumulator', async () => {
    const { env, _appended } = makeEnv({ mapped: true });

    // WRITE side: real cmdLogin persists {allMsgMode:true} to the real SESSIONS store.
    await cmdLogin({ chat: { id: GROUP, type: 'supergroup' }, from: { id: 7 }, text: '/login owner pw' }, env);

    // READ side: real dispatchInner → real getOrCreateMappedSession reads it BACK from
    // the same store, through the CHAT_MAPPINGS re-derivation.
    await dispatchInner(ambient('первая мысль'), env);

    expect(handleMessage).not.toHaveBeenCalled();      // not launched per-message
    expect(_appended).toHaveLength(1);                 // reached the intake buffer
    expect(_appended[0]).toMatchObject({ text: 'первая мысль', flush: false });
  });

  it('/all_on in a mapped group → next ambient message reaches the accumulator', async () => {
    const { env, _appended } = makeEnv({ mapped: true });

    // Pre-seed a mapped session (as the mapping would on first contact), then /all_on.
    await handleCommand({ chat: { id: GROUP, type: 'supergroup' }, from: { id: 7 }, text: '/all_on' }, env);

    await dispatchInner(ambient('вторая мысль'), env);

    expect(_appended).toHaveLength(1);
    expect(_appended[0]).toMatchObject({ text: 'вторая мысль', flush: false });
  });

  it('the real prod scenario: a MAPPED group with NO /login or /all_on still accumulates', async () => {
    // This is exactly the live chat: CHAT_MAPPINGS binds it to a profile, cmdLogin
    // refuses manual login there, so allMsgMode is never persisted. A mapped chat is
    // an operator-curated workspace → ambient messages must reach the accumulator with
    // no command and no memberCount gate. Was RED before the mapping⇒all-msg fix.
    const { env, _appended } = makeEnv({ mapped: true });
    await dispatchInner(ambient('без всякого логина'), env);
    expect(_appended).toHaveLength(1);
    expect(_appended[0]).toMatchObject({ text: 'без всякого логина', flush: false });
  });

  it('control: an UNMAPPED group with no all-msg mode drops ambient (the gate still bites)', async () => {
    const { env, _appended } = makeEnv({ mapped: false });
    await dispatchInner(ambient('случайная группа'), env);
    expect(_appended).toHaveLength(0);
  });
});
