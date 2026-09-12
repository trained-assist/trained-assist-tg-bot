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
// username: alphanumeric profile name (NOT the numeric Telegram chat ID)
export async function pickAgentUrl(env, username, task, forceRu = false) {
  if (forceRu && env.AGENT_RU_URL) return env.AGENT_RU_URL;
  if (!env.AGENT_RU_URL) return env.AGENT_URL;

  // Empty task → no RU-only keyword can match → skip the 2.5s capability probe
  if (!task) return env.AGENT_URL;

  const ruCaps = await getCapabilities(env.AGENT_RU_URL, env.AGENT_SECRET, username);
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

export async function getProjects(env, { username, userId }) {
  // Probe RU VM capabilities so users with nalog/gosuslugi tokens see projects
  // from the VM their tasks actually run on, not always GCP.
  let agentUrl = env.AGENT_URL;
  if (username && env.AGENT_RU_URL) {
    const ruCaps = await getCapabilities(env.AGENT_RU_URL, env.AGENT_SECRET, username);
    if (ruCaps.length > 0) agentUrl = env.AGENT_RU_URL;
  }
  try {
    const res = await fetch(
      `${agentUrl}/projects?username=${encodeURIComponent(username)}`,
      { headers: { 'Authorization': `Bearer ${env.AGENT_SECRET}` }, signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.projects || [];
  } catch {
    return [];
  }
}

export async function runTask(env, { userId, username, task, context, sessionId, contextFromSession, forceRu, forceClaude, initialMsgId, pinnedMsgId, telegramUserId, projectDir, fileBase64, fileName, fileMimeType }) {
  const agentUrl = await pickAgentUrl(env, username, task || '', forceRu);
  const body = { userId, username, context, sessionId, contextFromSession };
  if (task) body.task = task;
  if (forceClaude) body.forceClaude = true;
  if (initialMsgId) body.initialMsgId = initialMsgId;
  if (pinnedMsgId) body.pinnedMsgId = pinnedMsgId;
  if (telegramUserId) body.telegramUserId = telegramUserId;
  if (projectDir) body.projectDir = projectDir;
  if (fileBase64) body.fileBase64 = fileBase64;
  if (fileName) body.fileName = fileName;
  if (fileMimeType) body.fileMimeType = fileMimeType;

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

/**
 * ШАГ 1.2 completeness gate: ask the agent's cheap LLM whether a coalesced
 * intake buffer is a finished thought or an obviously cut-off fragment.
 * Fails open (complete:true) on any error — the gate must never trap the user.
 */
/**
 * ШАГ 1.3 busy-hold poll: is a Claude session live for this user right now?
 * The agent /run returns 202 on enqueue, so the gateway can't learn a run's
 * real duration from the dispatch call — it must read live state. The DO polls
 * this to hold new messages until the session actually frees up.
 *
 * Fails CLOSED (running:true) on any error: an unreachable agent must keep the
 * hold, not release it prematurely and per-message-dispatch mid-run. The DO's
 * BUSY_MAX safety alarm is the ultimate backstop against a hold that never clears.
 */
export async function isTaskRunning(env, { username }) {
  try {
    const res = await fetch(
      `${env.AGENT_URL}/tasks/running?username=${encodeURIComponent(username)}`,
      { headers: { 'Authorization': `Bearer ${env.AGENT_SECRET}` }, signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return { running: true };
    const data = await res.json();
    return { running: data.running === true };
  } catch {
    return { running: true };
  }
}

export async function checkCompleteness(env, { text }) {
  try {
    const res = await fetch(`${env.AGENT_URL}/intake-gate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.AGENT_SECRET}`,
      },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { complete: true };
    return res.json();
  } catch {
    return { complete: true };
  }
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

export async function reportBugOrFeature(env, { username, description, sessionId }) {
  const res = await fetch(`${env.AGENT_URL}/report`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.AGENT_SECRET}`,
    },
    body: JSON.stringify({ username, description, sessionId }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `agent /report HTTP ${res.status}`);
  }
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

export async function stopTask(env, { username }) {
  const res = await fetch(`${env.AGENT_URL}/tasks/stop`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.AGENT_SECRET}`,
    },
    body: JSON.stringify({ username }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`agent /tasks/stop HTTP ${res.status}`);
  return res.json();
}
