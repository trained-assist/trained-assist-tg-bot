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

// Like getSession, but auto-creates session for chats in CHAT_MAPPINGS
export async function getOrCreateMappedSession(kv, chatId, env, telegramUserId = null) {
  const session = await getSession(kv, chatId);
  const mappedProfile = getChatProfileFromMapping(chatId, env);
  if (!mappedProfile) return session;

  if (!session || session.username !== mappedProfile) {
    // Spread existing session to preserve fields like allMsgMode, allMsgPinnedId, pinnedMsgId
    const mapped = { ...(session || {}), username: mappedProfile, name: mappedProfile, telegramUserId };
    await setSession(kv, chatId, mapped);
    return mapped;
  }
  return session;
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
