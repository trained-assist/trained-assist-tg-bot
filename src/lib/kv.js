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

// Workers KV gives no read-after-write guarantee across requests — the write that
// stashes pending picker state (from the message that showed a picker) and the read
// here (from the button tap moments later) are different requests and can land on
// different colos. A picker tapped quickly after being shown can then see a session
// that looks like the pending state was never written. One retry after a short delay
// recovers the overwhelming majority of these without adding latency to the common
// (already-consistent) case, and costs nothing extra when the state really is stale.
export async function withKvConsistencyRetry(kv, chatId, session, isReady, delayMs = 400) {
  if (isReady(session)) return session;
  await new Promise(resolve => setTimeout(resolve, delayMs));
  const retried = await getSession(kv, chatId);
  return isReady(retried) ? retried : session;
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

// Persist until a terminal outcome is acknowledged; never expire work silently.
const RETRY_DELAY_MS = 3 * 60 * 1000;
export async function scheduleRetry(kv, { chatId, text, opts }) {
  const dueAt = Date.now() + RETRY_DELAY_MS;
  const key = `retry:${chatId}:${crypto.randomUUID()}`;
  await kv.put(key, JSON.stringify({ chatId, text, opts, dueAt }), { metadata: { dueAt } });
  return key;
}

export async function takeDueRetries(kv) {
  const due = [];
  let cursor;
  do {
    const list = await kv.list({ prefix: 'retry:', ...(cursor ? { cursor } : {}) });
    for (const k of list.keys) {
      if ((k.metadata?.dueAt ?? 0) > Date.now()) continue;
      const val = await kv.get(k.name);
      if (!val) continue;
      try { due.push({ ...JSON.parse(val), retryKey: k.name }); }
      catch (err) { console.error('[recovery] invalid entry', k.name, err.message); }
    }
    cursor = list.list_complete === false ? list.cursor : null;
  } while (cursor);
  return due;
}

// Write intent before /run. A worker crash after this point has an ambiguous
// outcome: notify instead of blindly sending the same non-idempotent request.
export async function markRetryStarted(kv, entry) {
  await kv.put(entry.retryKey, JSON.stringify({ ...entry, startedAt: Date.now(), dueAt: Date.now() + 120000 }),
    { metadata: { dueAt: Date.now() + 120000 } });
}
export async function finishRetry(kv, entry, outcome) {
  const key = entry.retryKey;
  await kv.put(`recovery-result:${key}`, JSON.stringify({ chatId: entry.chatId,
    attempt: (entry.opts?.retryAttempt || 0) + 1, outcome, finishedAt: Date.now() }),
    { expirationTtl: 7 * 24 * 60 * 60 });
  await kv.delete(key);
}

export async function saveRetryOutcome(kv, entry, terminal) {
  await kv.put(entry.retryKey, JSON.stringify({ ...entry, terminal, dueAt: Date.now() }),
    { metadata: { dueAt: Date.now() } });
}
