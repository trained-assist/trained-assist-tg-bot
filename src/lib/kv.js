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

// Class B self-heal (issue #604): when the agent is classified 'down', queue ONE
// delayed retry instead of dead-ending on "попробуй через минуту". The Worker is
// stateless and can't setTimeout for minutes, so the retry queue lives in KV and
// is drained by a Cron Trigger (see scheduled() in index.js).
const RETRY_DELAY_MS = 3 * 60 * 1000; // owner's own estimate — restart+redeploy margin, see #604
const RETRY_TTL_SECONDS = 10 * 60; // self-cleans if the cron somehow never picks it up

export async function scheduleRetry(kv, { chatId, text, opts }) {
  const dueAt = Date.now() + RETRY_DELAY_MS;
  const key = `retry:${chatId}:${Date.now()}`;
  await kv.put(key, JSON.stringify({ chatId, text, opts, dueAt }), {
    expirationTtl: RETRY_TTL_SECONDS,
    metadata: { dueAt },
  });
}

// Pop every retry whose dueAt has passed. Deletes each key BEFORE the caller acts
// on it — that's what caps this at exactly one attempt, without a separate
// "attempted" flag: an overlapping cron tick simply finds nothing left to take.
export async function takeDueRetries(kv) {
  const list = await kv.list({ prefix: 'retry:' });
  const now = Date.now();
  const due = [];
  for (const k of list.keys) {
    if ((k.metadata?.dueAt ?? 0) > now) continue;
    const val = await kv.get(k.name);
    await kv.delete(k.name);
    if (val) due.push(JSON.parse(val));
  }
  return due;
}
