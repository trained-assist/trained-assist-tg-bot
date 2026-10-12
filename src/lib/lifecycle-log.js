const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/;
const FIELDS = new Set([
  'event', 'component', 'correlationId', 'requestId', 'taskId', 'deliveryId',
  'status', 'outcome', 'reasonCode', 'route', 'answerPresent', 'answerLength',
  'providerMessageId', 'generation', 'attempt', 'routingPending', 'duplicate',
]);

function safeValue(key, value) {
  if (value == null) return undefined;
  if (['event', 'component', 'status', 'outcome', 'reasonCode', 'route'].includes(key)) {
    return typeof value === 'string' && SAFE_CODE.test(value) ? value : undefined;
  }
  if (['correlationId', 'requestId', 'taskId', 'deliveryId'].includes(key)) {
    return typeof value === 'string' && SAFE_ID.test(value) ? value : undefined;
  }
  if (['answerPresent', 'routingPending', 'duplicate'].includes(key)) return typeof value === 'boolean' ? value : undefined;
  if (['answerLength', 'providerMessageId', 'generation', 'attempt'].includes(key)) {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }
  return undefined;
}

/** Emit only bounded lifecycle metadata. Payloads, chat/user IDs and error text are dropped. */
export function formatLifecycleEvent(fields, env = {}, now = new Date()) {
  const event = safeValue('event', fields?.event);
  if (!event) throw new TypeError('lifecycle_event_name_invalid');
  const safe = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (!FIELDS.has(key) || key === 'event') continue;
    const normalized = safeValue(key, value);
    if (normalized !== undefined) safe[key] = normalized;
  }
  const buildSha = typeof env.BUILD_SHA === 'string' && /^[a-f0-9]{7,40}$/i.test(env.BUILD_SHA)
    ? env.BUILD_SHA : undefined;
  return JSON.stringify({
    ts: now.toISOString(), service: 'trained-assist-tg-bot',
    ...(buildSha ? { buildSha } : {}), event, ...safe,
  });
}

export function logLifecycleEvent(fields, env = {}, sink = line => console.log(line)) {
  // Deployed Workers receive BUILD_SHA from the CI deploy workflow. This keeps
  // local/unit runs quiet unless a caller explicitly opts into lifecycle logs.
  if (!env.BUILD_SHA && env.LIFECYCLE_LOGS !== 'true') return null;
  const line = formatLifecycleEvent(fields, env);
  sink(line);
  return line;
}

export default { formatLifecycleEvent, logLifecycleEvent };
