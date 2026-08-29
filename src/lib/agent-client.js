// HTTP client for alesa-agent

export async function runTask(env, { userId, username, task, context }) {
  const res = await fetch(`${env.AGENT_URL}/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.AGENT_SECRET}`,
    },
    body: JSON.stringify({ userId, username, task, context }),
  });
  if (!res.ok) throw new Error(`agent /run HTTP ${res.status}`);
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
