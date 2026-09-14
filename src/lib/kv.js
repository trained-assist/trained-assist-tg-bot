// Cloudflare KV helpers for sessions and user registry

// Sessions: chatId → { username, profileName }
export async function getSession(kv, chatId) {
  const val = await kv.get(String(chatId));
  return val ? JSON.parse(val) : null;
}

// Parse CHAT_MAPPINGS env var: returns mapped profile name or null
export function getChatProfileFromMapping(chatId, env) {
  if (!env.CHAT_MAPPINGS) return null;
  try {
    const map = JSON.parse(env.CHAT_MAPPINGS);
    return map[String(chatId)] || null;
  } catch {
    return null;
  }
}

// Like getSession, but auto-creates session for chats in CHAT_MAPPINGS, and —
// as a last resort — revives a private-chat session from the telegram-user
// binding so auth follows the PERSON, not a single chatId (see getUserBinding).
export async function getOrCreateMappedSession(kv, chatId, env, telegramUserId = null) {
  const session = await getSession(kv, chatId);
  const mappedProfile = getChatProfileFromMapping(chatId, env);

  if (mappedProfile) {
    if (!session || session.username !== mappedProfile) {
      // Spread existing session to preserve fields like allMsgMode, allMsgPinnedId, pinnedMsgId
      const mapped = { ...(session || {}), username: mappedProfile, name: mappedProfile, telegramUserId };
      await setSession(kv, chatId, mapped);
      return mapped;
    }
    return session;
  }

  if (session) return session;

  // No per-chat session and no static mapping: fall back to the telegram-user
  // binding so a login done once is recognized across the user's chats and
  // survives session eviction. Gate on chatId === telegramUserId — i.e. the
  // user's own private chat (in a DM chat.id equals from.id) — so a group is
  // NEVER auto-bound to whichever member happens to write (no cross-profile leak).
  if (telegramUserId && String(chatId) === String(telegramUserId)) {
    const binding = await getUserBinding(kv, telegramUserId);
    if (binding?.username) {
      const revived = { username: binding.username, name: binding.name || binding.username, telegramUserId };
      await setSession(kv, chatId, revived);
      return revived;
    }
  }
  return null;
}

// Telegram-user → profile binding: `tguser:<telegramUserId>` → { username, name }.
// Written on /login, cleared on /logout. Lets auth follow the person rather than
// a single chatId, so the same telegram user is recognized in any of their chats.
export async function getUserBinding(kv, telegramUserId) {
  if (!telegramUserId) return null;
  const val = await kv.get(`tguser:${telegramUserId}`);
  return val ? JSON.parse(val) : null;
}

export async function setUserBinding(kv, telegramUserId, data) {
  if (!telegramUserId) return;
  await kv.put(`tguser:${telegramUserId}`, JSON.stringify(data));
}

export async function deleteUserBinding(kv, telegramUserId) {
  if (!telegramUserId) return;
  await kv.delete(`tguser:${telegramUserId}`);
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
