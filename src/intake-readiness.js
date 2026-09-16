// Read-only deployment contract: malformed input is rejected before profile access,
// LLM calls, session creation or Telegram sends. Probe from the actual Worker so
// its secret, URL (including /agent) and optional regional backend are exercised.
export async function intakeReadiness(env) {
  if (env.INTAKE_DEBOUNCE === 'off' || !env.INTAKE || !env.SESSIONS || !env.AGENT_SECRET || !env.AGENT_URL || !env.DEEPGRAM_API_KEY) {
    return { ready: false, quickBeforeCollect: true, reason: 'intake configuration missing or disabled' };
  }
  const backends = await Promise.all([...new Set([env.AGENT_URL, env.AGENT_RU_URL].filter(Boolean))].map(async url => {
    try {
      const response = await fetch(`${url}/intake-quick`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.AGENT_SECRET}` },
        body: '{}', signal: AbortSignal.timeout(5000),
      });
      const body = await response.json();
      return { ready: response.status === 400 && body.error === 'invalid intake request', status: response.status };
    } catch { return { ready: false, status: 0 }; }
  }));
  return { ready: backends.every(b => b.ready), quickBeforeCollect: true, backends: backends.map(b => b.ready), backendStatuses: backends.map(b => b.status) };
}
