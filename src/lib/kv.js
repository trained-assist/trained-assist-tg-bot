// Cloudflare KV helpers for sessions and user registry

// Single home for session-id generation. Was copy-pasted as
// `s-${Math.abs(chatId)}-${Date.now()}` in 6 places — every duplicate is a chance
// for the sign handling to drift, which is exactly how a group chat ended up with
// two divergent session families (`s-1003…` vs `s--1003…`) and lost its ТЗ
// (chatId-sign-split-session-loss). Keep the id derivation in ONE place so the
// invariant "id is a stable, unique key" can never fork again. The agent resolves
// continuity via its per-chat current-session pointer (keyed by the real signed
// chatId), so the id string itself is just an opaque key.
export function newSessionId(chatId) {
  return `s-${Math.abs(chatId)}-${Date.now()}`;
}

// Sessions: chatId → { username, profileName }
export async function getSession(kv, chatId) {
  const val = await kv.get(String(chatId));
  return val ? JSON.parse(val) : null;
}

export async function setSession(kv, chatId, session) {
  await kv.put(String(chatId), JSON.stringify(session));
}

export async function deleteSession(kv, chatId) {
  await kv.delete(String(chatId));
}

// Users registry: username → { name, passwordHash, salt, workDir, createdAt }
export async function getUser(kv, username) {
  const val = await kv.get(`user:${username}`);
  return val ? JSON.parse(val) : null;
}

export async function setUser(kv, username, data) {
  await kv.put(`user:${username}`, JSON.stringify(data));
}

export async function deleteUser(kv, username) {
  await kv.delete(`user:${username}`);
}

export async function listUsernames(kv) {
  const list = await kv.list({ prefix: 'user:' });
  return list.keys.map(k => k.name.replace('user:', ''));
}
