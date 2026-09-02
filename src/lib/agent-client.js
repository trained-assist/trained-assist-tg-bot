// HTTP client for trained-assist-agent

// Services that only work from Russian IP — routing based on which VM holds the token,
// not on keyword-matching the task text.
// Each entry: service name (matches filename in ~/agent-tokens/{userId}/) → task aliases
const RU_ONLY_SERVICES = {
  nalog:     ['nalog', 'налог', 'нпд', 'lknpd', 'самозанят', 'чек нпд', 'выбить чек', 'пробить чек', 'fns.ru'],
  gosuslugi: ['gosuslugi', 'госуслуги', 'esia', 'есиа', 'mos.ru'],
};

// Fetch what services this user has tokens for on a given agent VM.
// Returns [] on timeout or error (fail-open: route to GCP by default).
async function getCapabilities(agentUrl, secret, userId) {
  try {
    const res = await fetch(`${agentUrl}/capabilities?userId=${userId}`, {
      headers: { 'Authorization': `Bearer ${secret}` },
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.capabilities || [];
  } catch {
    return [];
  }
}

// Returns the agent URL to use for this task.
// Queries RU VM capabilities first; falls back to GCP on error/timeout.
export async function pickAgentUrl(env, userId, task, forceRu = false) {
  if (forceRu && env.AGENT_RU_URL) return env.AGENT_RU_URL;
  if (!env.AGENT_RU_URL) return env.AGENT_URL;

  // Empty task → no RU-only keyword can match → skip the 2.5s capability probe
  if (!task) return env.AGENT_URL;

  const ruCaps = await getCapabilities(env.AGENT_RU_URL, env.AGENT_SECRET, userId);
  if (ruCaps.length === 0) return env.AGENT_URL;

  // Normalize task for matching (collapse STT dot-splitting like "na log.ru" → "nalog.ru")
  const lc = task.toLowerCase().replace(/\s*\.\s*/g, '.').replace(/\bna\s+log\b/g, 'nalog');

  for (const cap of ruCaps) {
    const aliases = RU_ONLY_SERVICES[cap];
    if (!aliases) continue; // service isn't RU-only, skip
    if (aliases.some(kw => lc.includes(kw))) return env.AGENT_RU_URL;
  }

  return env.AGENT_URL;
}

export async function runTask(env, { userId, username, task, context, sessionId, contextFromSession, forceRu, forceClaude, initialMsgId, pinnedMsgId, telegramUserId }) {
  const agentUrl = await pickAgentUrl(env, userId, task || '', forceRu);
  const body = { userId, username, context, sessionId, contextFromSession };
  if (task) body.task = task;
  if (forceClaude) body.forceClaude = true;
  if (initialMsgId) body.initialMsgId = initialMsgId;
  if (pinnedMsgId) body.pinnedMsgId = pinnedMsgId;
  if (telegramUserId) body.telegramUserId = telegramUserId;

  const MAX_ATTEMPTS = 3;
  const RETRY_DELAY_MS = 2000;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt));
    const res = await fetch(`${agentUrl}/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.AGENT_SECRET}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) return res.json();
    const isRetryable = res.status === 502 || res.status === 503;
    if (!isRetryable || attempt === MAX_ATTEMPTS - 1) {
      throw new Error(`agent /run HTTP ${res.status}`);
    }
  }
}

export async function getSessions(env, { username, limit = 10 }) {
  const res = await fetch(
    `${env.AGENT_URL}/sessions?username=${encodeURIComponent(username)}&limit=${limit}`,
    { headers: { 'Authorization': `Bearer ${env.AGENT_SECRET}` } }
  );
  if (!res.ok) throw new Error(`agent /sessions HTTP ${res.status}`);
  const { sessions } = await res.json();
  return sessions;
}

export async function getFiles(env, { username, path = '' }) {
  const qs = `username=${encodeURIComponent(username)}&path=${encodeURIComponent(path)}`;
  const res = await fetch(`${env.AGENT_URL}/files?${qs}`, {
    headers: { 'Authorization': `Bearer ${env.AGENT_SECRET}` },
  });
  if (!res.ok) throw new Error(`agent /files HTTP ${res.status}`);
  return res.json();
}

export async function readFile(env, { username, path }) {
  const qs = `username=${encodeURIComponent(username)}&path=${encodeURIComponent(path)}`;
  const res = await fetch(`${env.AGENT_URL}/files/read?${qs}`, {
    headers: { 'Authorization': `Bearer ${env.AGENT_SECRET}` },
  });
  if (!res.ok) throw new Error(`agent /files/read HTTP ${res.status}`);
  return res.json();
}

export async function classifyMessage(env, { message, sessions }) {
  const res = await fetch(`${env.AGENT_URL}/classify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.AGENT_SECRET}`,
    },
    body: JSON.stringify({ message, sessions }),
  });
  if (!res.ok) return { sessionId: null, confidence: 'low' }; // fail safe
  return res.json();
}

export async function setUserToken(env, { userId, label, value }) {
  const res = await fetch(`${env.AGENT_URL}/tokens`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.AGENT_SECRET}`,
    },
    body: JSON.stringify({ userId, label, value }),
  });
  if (!res.ok) throw new Error(`agent /tokens HTTP ${res.status}`);
  return res.json();
}

export async function getSkills(env) {
  const res = await fetch(`${env.AGENT_URL}/skills`, {
    headers: { 'Authorization': `Bearer ${env.AGENT_SECRET}` },
  });
  if (!res.ok) throw new Error(`agent /skills HTTP ${res.status}`);
  const { skills } = await res.json();
  return skills;
}

export async function archiveSessions(env, { username, sessionIds }) {
  const res = await fetch(`${env.AGENT_URL}/sessions/archive`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.AGENT_SECRET}`,
    },
    body: JSON.stringify({ username, sessionIds }),
  });
  if (!res.ok) throw new Error(`agent /sessions/archive HTTP ${res.status}`);
  return res.json();
}

export async function getAgentHealth(env) {
  try {
    const res = await fetch(`${env.AGENT_URL}/health`, {
      headers: { 'Authorization': `Bearer ${env.AGENT_SECRET}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}
