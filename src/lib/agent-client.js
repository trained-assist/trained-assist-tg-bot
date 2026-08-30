// HTTP client for trained-assist-agent

// Russian geo-blocked services — route to RU VM automatically
// These are typically blocked from GCP (EU). Western services stay on GCP by default.
const RU_SERVICE_KEYWORDS = [
  // Налоги
  'nalog', 'налог', 'нпд', 'фнс', 'fns.ru',
  // Госуслуги и ведомства
  'gosuslugi', 'госуслуги', 'esia', 'есиа',
  'mos.ru', 'мос.ру',
  'pfr', 'пфр', 'sfr', 'сфр',
  'rosreestr', 'росреестр',
  'mvd.gov', 'мвд',
  'cbr.ru', 'цб.рф', 'центробанк',
  // Российские банки
  'сбербанк', 'sberbank', 'сбер', 'sber',
  'тинькофф', 'tinkoff',
  'втб', 'vtb',
  'альфабанк', 'alfabank', 'альфа-банк',
  'газпромбанк', 'raiffeisen',
  // Другое РФ
  'sbis', 'сбис', 'kontur', 'контур',
];

export function needsRuAgent(task) {
  const lc = task.toLowerCase();
  return RU_SERVICE_KEYWORDS.some(kw => lc.includes(kw));
}

export function pickAgentUrl(env, task, forceRu = false) {
  if ((forceRu || needsRuAgent(task)) && env.AGENT_RU_URL) return env.AGENT_RU_URL;
  return env.AGENT_URL;
}

export async function runTask(env, { userId, username, task, context, sessionId, contextFromSession, forceRu }) {
  const agentUrl = pickAgentUrl(env, task, forceRu);
  const res = await fetch(`${agentUrl}/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.AGENT_SECRET}`,
    },
    body: JSON.stringify({ userId, username, task, context, sessionId, contextFromSession }),
  });
  if (!res.ok) throw new Error(`agent /run HTTP ${res.status}`);
  return res.json();
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
