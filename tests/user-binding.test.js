import { describe, it, expect, beforeEach } from 'vitest';
import {
  getOrCreateMappedSession,
  setSession,
  deleteSession,
  getUserBinding,
  setUserBinding,
  deleteUserBinding,
} from '../src/lib/kv.js';

// Auth must follow the TELEGRAM USER, not the chatId. Before this fix, a login
// wrote a session under String(chatId) only; if that per-chat session was ever
// absent (evicted, or a chat the user hadn't run /login in) the bot answered
// "Сначала войди" even though the same telegram user was already authenticated
// elsewhere. These tests lock the durable tguser:<id> → profile binding and its
// safe, group-avoiding fallback.

function makeKv() {
  const store = new Map();
  return {
    _store: store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
  };
}

const NO_MAPPING = {}; // env without CHAT_MAPPINGS

beforeEach(() => {});

describe('telegram-user → profile binding', () => {
  it('revives a private-chat session from the user binding when the per-chat session is gone', async () => {
    const kv = makeKv();
    const uid = 555; // private chat: chat.id === from.id
    await setUserBinding(kv, uid, { username: 'maryam', name: 'Maryam' });

    // No per-chat session exists (never created / evicted), no CHAT_MAPPINGS.
    const session = await getOrCreateMappedSession(kv, uid, NO_MAPPING, uid);

    expect(session).not.toBeNull();
    expect(session.username).toBe('maryam');
    // and it persists the revived session for the chat
    expect(await getOrCreateMappedSession(kv, uid, NO_MAPPING, uid)).toMatchObject({ username: 'maryam' });
  });

  it('does NOT auto-bind a group chat from a member binding (no cross-profile leak)', async () => {
    const kv = makeKv();
    const uid = 555;
    const groupChatId = -1001234567890; // group: chat.id !== from.id
    await setUserBinding(kv, uid, { username: 'maryam', name: 'Maryam' });

    const session = await getOrCreateMappedSession(kv, groupChatId, NO_MAPPING, uid);
    expect(session).toBeNull();
  });

  it('CHAT_MAPPINGS still wins and is unaffected by user bindings', async () => {
    const kv = makeKv();
    const uid = 555;
    await setUserBinding(kv, uid, { username: 'maryam', name: 'Maryam' });
    const env = { CHAT_MAPPINGS: JSON.stringify({ [String(uid)]: 'teamprofile' }) };

    const session = await getOrCreateMappedSession(kv, uid, env, uid);
    expect(session.username).toBe('teamprofile');
  });

  it('logout clears the binding so the user is no longer auto-recognized', async () => {
    const kv = makeKv();
    const uid = 555;
    await setUserBinding(kv, uid, { username: 'maryam', name: 'Maryam' });
    await setSession(kv, uid, { username: 'maryam', name: 'Maryam', telegramUserId: uid });

    // logout: delete both chat session and user binding
    await deleteSession(kv, uid);
    await deleteUserBinding(kv, uid);

    expect(await getUserBinding(kv, uid)).toBeNull();
    expect(await getOrCreateMappedSession(kv, uid, NO_MAPPING, uid)).toBeNull();
  });

  it('a missing telegramUserId falls through to null (no crash)', async () => {
    const kv = makeKv();
    expect(await getOrCreateMappedSession(kv, 123, NO_MAPPING, null)).toBeNull();
    expect(await getUserBinding(kv, null)).toBeNull();
  });
});
