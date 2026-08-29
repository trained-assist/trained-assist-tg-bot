// HTTP client for alesa-agent

export async function runTask(env, { userId, username, task, context, sessionId }) {
  const res = await fetch(`${env.AGENT_URL}/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.AGENT_SECRET}`,
    },
    body: JSON.stringify({ userId, username, task, context, sessionId }),
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
