import { conversationKey } from '../conversation-context.js';
import { copyRefsToAgent, releaseBufferPins } from './intake-files.js';
import { resolveAudience } from './audience.js';
import { runInputTaskId } from '../input-assembly.js';
import { pendingGroupHistory, formatHistoryBlock, ackGroupHistory, maxSeq, isGroupChatId } from '../group-history.js';
import { applyTestDelivery, isTestChat, reserveChatId } from './test-mode.js';
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

// The REAL model input of a dispatched run (agent-side: system prompt +
// context/task exactly as the engine received it) for the «Посмотреть input»
// button — GET /internal/run-input. Tries the agent pickAgentUrl chooses for
// the same task text (how the run was routed), then the other configured agent.
// Never throws: a miss (run predates the feature, other agent, network) returns
// null and the caller falls back to its gateway-side snapshot view.
export async function fetchRunInput(env, body) {
  try {
    const taskId = runInputTaskId(body);
    const username = body?.username;
    if (!taskId || !username) return null;
    const primary = await pickAgentUrl(env, username, body.task || '');
    const candidates = [...new Set([primary, env.AGENT_RU_URL, env.AGENT_URL].filter(Boolean))];
    const query = `username=${encodeURIComponent(username)}&taskId=${encodeURIComponent(taskId)}`;
    for (const base of candidates) {
      try {
        const res = await fetch(`${base}/internal/run-input?${query}`, {
          headers: { Authorization: `Bearer ${env.AGENT_SECRET || ''}` },
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          const text = await res.text();
          if (text) return text;
        }
      } catch { /* try the next candidate */ }
    }
    return null;
  } catch {
    return null;
  }
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

export async function runTask(env, { userId, username, task, context, sessionId, contextFromSession, forceRu, forceClaude, forceNew, mode, initialMsgId, pinnedMsgId, telegramUserId, projectId, projectPicked = false, newProjectName, fileBase64, fileName, fileMimeType, fileRefs, inputItems, requestId, threadId = null, initiatedAt = Date.now() }) {
  const audience = resolveAudience(env);
  // Send chatId alongside legacy userId — agent's /run now accepts either (P1-B of
  // naming-conventions refactor, plan generic-naming-conventions-refactoring §4). userId
  // here has always meant the Telegram chat to stream into; chatId is the forward-looking
  // wire name for that same value. Drop userId only after agent flips chatId canonical (PR-D).
  const body = { userId, chatId: userId, username, context, sessionId, contextFromSession, threadId, initiatedAt, audience };
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
  // Explicit menu choice only (#1318): the agent pins the chat to this project. Auto /
  // remembered / pinned ids are forwarded without it so they never (re)pin.
  if (projectId && projectPicked === true) body.projectPicked = true;
  if (newProjectName) body.newProjectName = newProjectName;
  if (fileBase64) body.fileBase64 = fileBase64;
  if (fileName) body.fileName = fileName;
  if (fileMimeType) body.fileMimeType = fileMimeType;

  // Group chat: what participants said while the bot stayed quiet (src/group-history.js),
  // only entries no accepted run carried yet. Before the snapshot, so a retry replays the
  // same context and «Посмотреть input» shows it. `groupHistory` (structured) lets the
  // agent keep them for the get_group_history MCP tool.
  if (isGroupChatId(userId)) {
    const pending = await pendingGroupHistory(env, userId, threadId);
    const history = formatHistoryBlock(pending);
    if (history) {
      body.context = body.context ? `${history}\n\n${body.context}` : history;
      body.groupHistory = pending.map(({ id, seq, ts, from, text, file }) => ({ id, seq, ts, from, text, ...(file ? { file } : {}) }));
    }
  }
  // Acked only once the agent accepted the run: a failed run repeats the entries next time.
  // Computed from the final (possibly snapshot-replayed) body — that's what was delivered.
  const ackHistory = () => ackGroupHistory(env, userId, threadId, maxSeq(body.groupHistory));

  if (env.INTAKE && inputItems) {
    body.requestId ||= initialMsgId ? `msg-${userId}-${initialMsgId}` : crypto.randomUUID();
    const intake = env.INTAKE.get(env.INTAKE.idFromName(conversationKey(userId, threadId)));
    const saved = await intake.fetch('https://intake/snapshot', {
      method: 'POST', body: JSON.stringify({ body, items: inputItems }),
    });
    if (!saved.ok) throw new Error(`Input snapshot HTTP ${saved.status}`);
    // A retry sends exactly the immutable payload of its first attempt.
    const snapshot = await saved.json();
    for (const key of Object.keys(body)) delete body[key];
    Object.assign(body, snapshot.body);
  }

  const agentUrl = await pickAgentUrl(env, body.username, body.task || '', forceRu);
  await copyRefsToAgent(env, body.username, body.fileRefs || [], agentUrl);

  if (env.RUN_OUTBOX) {
    // Caller supplies Telegram/batch identity; fallback uses a stable status message.
    body.requestId ||= requestId || (initialMsgId ? `msg-${userId}-${initialMsgId}` : crypto.randomUUID());
    const stub = env.RUN_OUTBOX.get(env.RUN_OUTBOX.idFromName(`${username}:${userId}`));
    const res = await stub.fetch('https://outbox/enqueue', {
      method: 'POST', body: JSON.stringify({ agentUrl, body }),
    });
    if (!res.ok) throw Error(`outbox HTTP ${res.status}`);
    const queued = await res.json();
    await ackHistory();
    return queued;
  }

  // Test mode, last hop before POST /run on the DIRECT path (the outbox path
  // applies the same switchover in RunOutbox.alarm). No-op for regular chats.
  applyTestDelivery(env, body);

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
      await ackHistory();
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
  // Never 'ask' (owner decision 2026-09-26): without a decision the agent binds the chat's
  // current project itself (pinned → last used → «Все подряд»).
  return { action: data.projects.length ? 'auto' : 'create', choices: [], active: null };
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
 * { level: 'clear'|'likely'|'insufficient' }. Errors hold the buffer for manual launch.
 */
// A judge that did not answer is NOT a verdict. Collapsing timeout/5xx/bad body
// into `insufficient` (the pre-#248 behaviour) made a degraded judge look exactly
// like «your message is unclear» — the batch then lost its auto-launch timer with
// nothing telling the user why. `error` is retried by the intake DO instead of
// being announced as a verdict (#248, live chat -1003814002203, 2026-09-29).
const gateError = () => ({ level: 'error', complete: false, delayMs: null, announce: null, retryable: true });

export async function checkCompleteness(env, { text, username = null, chatId = null, threadId = null } = {}) {
  // The verdict now carries delayMs/announce too (agent #1823): the judge decides
  // how long to wait and what to say. Older agents simply omit those fields, so the
  // gateway falls back to its own 3-minute timer.
  const body = { text };
  if (username) body.username = username;
  if (chatId !== null && chatId !== undefined) body.chatId = chatId;
  if (threadId !== null && threadId !== undefined) body.threadId = threadId;
  try {
    const res = await fetch(`${env.AGENT_URL}/intake-gate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.AGENT_SECRET}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return gateError();
    const result = await res.json();
    return ['clear', 'likely', 'insufficient', 'continue', 'error'].includes(result?.level)
      ? result : gateError();
  } catch {
    return gateError();
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

// «▶️ Делать» / «✖️ Отменить» under a forgotten-checklist reminder (#1729 BV-08/08a).
// Deterministic agent route (no LLM): { ok, status, text } — text is what the gateway
// edits the reminder message into.
export async function orphanChecklistAction(env, { username, action, id, chatId = null, threadId = null }) {
  const tid = Number.isInteger(threadId) && threadId > 0 ? threadId : null;
  const body = { username, action, id, chatId, audience: resolveAudience(env) };
  if (tid != null) body.threadId = tid;
  const res = await fetch(`${env.AGENT_URL}/internal/orphan-checklists/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.AGENT_SECRET}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`agent /internal/orphan-checklists/action HTTP ${res.status}`);
  return res.json();
}

export async function stopTask(env, { username, chatId = null, threadId = null }) {
  const tid = Number.isInteger(threadId) && threadId > 0 ? threadId : null;
  // ALWAYS scope the stop by this bot's audience + the chat (+ forum topic when
  // present). A `{ username }`-only payload makes the agent's /tasks/stop a
  // profile-wide kill inside audience 'default', so a private-chat /stop or the
  // ⛔ Стоп button could SIGTERM a sibling task sharing the same profile — most
  // notably a web-interface session (chatId=0) that had nothing to do with the
  // Telegram chat (regression test: web session dies from a Telegram stop).
  // Sending the bot's own audience keeps recruiter/freelance stops scoped to
  // their own tasks instead of falling through to a wrong 'default' match, which
  // is exactly what the previous hard guard was protecting (#260) — it fixed the
  // audience regression by adding `audience`, but kept the unscoped { username }
  // payload for non-forum chats, reintroducing the cross-interface kill.
  const body = { username, chatId, audience: resolveAudience(env) };
  if (tid != null) body.threadId = tid;
  // Test mode (DESIGN §2.1): the live run is registered under the RESERVE id —
  // translate, or /stop finds nothing to kill.
  if (isTestChat(env, chatId)) body.chatId = reserveChatId(env, chatId);
  const res = await fetch(`${env.AGENT_URL}/tasks/stop`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.AGENT_SECRET}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`agent /tasks/stop HTTP ${res.status}`);
  return res.json();
}
