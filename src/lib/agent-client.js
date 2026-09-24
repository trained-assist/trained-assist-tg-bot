import { resolveAudience, resolveBotId } from './bot-context.js';
import { copyRefsToAgent, releaseBufferPins } from './intake-files.js';
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
  const audience = resolveAudience(env);
  try {
    const res = await fetch(
      `${agentUrl}/projects?username=${encodeURIComponent(username)}&audience=${audience}`,
      { headers: { 'Authorization': `Bearer ${env.AGENT_SECRET}` }, signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.projects || [];
  } catch {
    return [];
  }
}

export async function runTask(env, { userId, username, task, context, sessionId, contextFromSession, forceRu, forceClaude, forceNew, mode, initialMsgId, pinnedMsgId, telegramUserId, projectId, newProjectName, fileBase64, fileName, fileMimeType, fileRefs, requestId, threadId = null, initiatedAt = Date.now() }) {
  const agentUrl = await pickAgentUrl(env, username, task || '', forceRu);
  await copyRefsToAgent(env, username, fileRefs || [], agentUrl);
  const audience = resolveAudience(env);
  // Send chatId alongside legacy userId — agent's /run now accepts either (P1-B of
  // naming-conventions refactor, plan generic-naming-conventions-refactoring §4). userId
  // here has always meant the Telegram chat to stream into; chatId is the forward-looking
  // wire name for that same value. Drop userId only after agent flips chatId canonical (PR-D).
  const body = { userId, chatId: userId, username, context, sessionId, contextFromSession, threadId, initiatedAt, audience, botId: resolveBotId(env) };
  if (fileRefs?.length) body.fileRefs = fileRefs;
  if (requestId) body.requestId = requestId;
  if (task) body.task = task;
  if (forceClaude) body.forceClaude = true;
  if (forceNew) body.forceNew = true;
  if (mode) body.mode = mode;
  if (initialMsgId) body.initialMsgId = initialMsgId;
  if (pinnedMsgId) body.pinnedMsgId = pinnedMsgId;
  if (telegramUserId) body.telegramUserId = telegramUserId;
  if (projectId) body.projectId = projectId;
  if (newProjectName) body.newProjectName = newProjectName;
  if (fileBase64) body.fileBase64 = fileBase64;
  if (fileName) body.fileName = fileName;
  if (fileMimeType) body.fileMimeType = fileMimeType;

  if (env.RUN_OUTBOX) {
    // Caller supplies Telegram/batch identity; fallback uses a stable status message.
    body.requestId = requestId || (initialMsgId ? `msg-${userId}-${initialMsgId}` : crypto.randomUUID());
    const scope = audience === 'default' && body.botId === 'default' ? `${username}:${userId}` : `${audience}:${body.botId}:${username}:${userId}`;
    const stub = env.RUN_OUTBOX.get(env.RUN_OUTBOX.idFromName(scope));
    const res = await stub.fetch('https://outbox/enqueue', {
      method: 'POST', body: JSON.stringify({ agentUrl, body }),
    });
    if (!res.ok) throw Error(`outbox HTTP ${res.status}`);
    return res.json();
  }

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
    if (res.ok) {
      const ack=await res.json();
      if(ack.durable){await releaseBufferPins(env,username,fileRefs);if(agentUrl!==env.AGENT_URL)await releaseBufferPins(env,username,fileRefs,agentUrl);}
      return ack;
    }
    const isRetryable = res.status === 502 || res.status === 503;
    if (!isRetryable || attempt === MAX_ATTEMPTS - 1) {
      throw Object.assign(new Error(`agent /run HTTP ${res.status}`), { rejected: res.status >= 400 && res.status < 500 });
    }
  }
}

// The list remains available even if optional decision enrichment is broken.
// Failure is explicit: never turn an unavailable project service into "no projects".
export async function getProjectDecision(env, { username, chatId, task = '' }) {
  const headers = { Authorization: `Bearer ${env.AGENT_SECRET}` };
  const audience = resolveAudience(env);
  try {
    const res = await fetch(
      `${env.AGENT_URL}/project-decision?username=${encodeURIComponent(username)}&chatId=${encodeURIComponent(chatId)}&task=${encodeURIComponent(task)}&audience=${audience}`,
      { headers, signal: AbortSignal.timeout(9000) }
    );
    if (res.ok) {
      const data = await res.json();
      if (!data.note && ['auto', 'ask', 'create', 'quick'].includes(data.action) && Array.isArray(data.choices)) return data;
    }
  } catch { /* use the same agent's basic project list */ }
  const res = await fetch(`${env.AGENT_URL}/projects?username=${encodeURIComponent(username)}&audience=${audience}`,
    { headers, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error('Не удалось загрузить проекты. Попробуй ещё раз.');
  const data = await res.json();
  if (data.note || !Array.isArray(data.projects)) throw new Error('Не удалось загрузить проекты. Попробуй ещё раз.');
  return { action: data.projects.length > 1 ? 'ask' : data.projects.length ? 'auto' : 'create',
    choices: data.projects, active: null };
}

export async function getSessions(env, { username, limit = 10 }) {
  const audience = resolveAudience(env);
  const res = await fetch(
    `${env.AGENT_URL}/sessions?username=${encodeURIComponent(username)}&limit=${limit}&audience=${audience}`,
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
 * ШАГ 1.2 completeness gate: ask the agent's cheap LLM how confidently a
 * coalesced intake buffer reads as a finished, actionable request. Returns
 * { level: 'clear'|'likely'|'insufficient' }. Fails open to 'clear' on any
 * error — the gate must never silently trap the user.
 */
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
    if (!res.ok) return { level: 'clear', complete: true };
    return res.json();
  } catch {
    return { level: 'clear', complete: true };
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

// R10: classify a runTask failure into 'down' | 'busy' | 'error'.
// /run returns 202 immediately after enqueue, so a 15s AbortSignal timeout does
// NOT mean the agent is dead — it may just be busy (up to 6 concurrent tasks).
// Only 502/503 (proxy/agent genuinely failing) is 'down' outright; on timeout we
// probe /health and report 'busy' if the agent answers, 'down' if it doesn't.
// This prevents the false "недоступен → попробуй через минуту" that makes users
// resend and spawn duplicate sessions.
export async function classifyAgentError(env, err) {
  if (/HTTP 50[23]/.test(err.message)) return 'down';
  if (err.name === 'TimeoutError') {
    const healthy = await getAgentHealth(env);
    return healthy ? 'busy' : 'down';
  }
  return 'error';
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

export async function stopTask(env, { username, chatId, sessionId }) {
  if (!/^-?\d{1,20}$/.test(String(chatId))) throw new Error('chatId required for scoped stop');
  const res = await fetch(`${env.AGENT_URL}/tasks/stop`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.AGENT_SECRET}`,
    },
    body: JSON.stringify({ username, chatId, ...(sessionId ? { sessionId } : {}), audience: resolveAudience(env) }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`agent /tasks/stop HTTP ${res.status}`);
  return res.json();
}
