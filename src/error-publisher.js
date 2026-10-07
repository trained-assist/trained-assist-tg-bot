// C12 ErrorEvent publication to the System Error Watcher (POST /errors with
// x-watcher-key + x-watcher-scopes: error:write). Fire-and-forget: a transport
// failure spools the event in memory (capped at 100) and bumps the dropped
// counter, so publishing can never break the user path or throw at the call
// site. Same contract as the control-plane and ai-agent-runner publishers.

const SERVICE = 'trained-assist-tg-bot';
const WATCHER_SCOPES = 'error:write';
const PUBLISH_TIMEOUT_MS = 5000;
const SPOOL_MAX_ENTRIES = 100;
const SAFE_SUMMARY_MAX = 240;

const SENSITIVE_KEYS = new Set([
  'token',
  'secret',
  'password',
  'authorization',
  'apikey',
  'text',
  'answer',
  'payload',
  'transcript',
  'voice',
  'document',
  'filebytes',
  'bodybase64',
]);

const SECRET_PATTERNS = [
  /(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk-[A-Za-z0-9]{8,}\b/g,
  /\b(?:token|secret|password|api[_-]?key)\s*[=:]\s*[^\s"']+/gi,
];

let spool = [];
let droppedCount = 0;
let activePublisher = null;

export function getDroppedCount() {
  return droppedCount;
}

export function getSpool() {
  return [...spool];
}

// Cache for helpers that receive only a bot token (lib/telegram.js) — same
// pattern as initTestMode: entry points with env in hand initialise it once
// per request, token-only call sites read it.
export function initErrorPublisher(env) {
  activePublisher = resolveErrorPublisher(env);
}

export function activeErrorPublisher() {
  return activePublisher;
}

export function resolveErrorPublisher(env) {
  const watcherUrl = typeof env?.ERROR_WATCHER_URL === 'string' ? env.ERROR_WATCHER_URL.trim() : '';
  const watcherKey = typeof env?.ERROR_WATCHER_KEY === 'string' ? env.ERROR_WATCHER_KEY.trim() : '';
  if (!watcherUrl || !watcherKey) return null;
  const configuredEnv = typeof env?.ERROR_WATCHER_ENVIRONMENT === 'string' ? env.ERROR_WATCHER_ENVIRONMENT.trim() : '';
  return createErrorPublisher({
    watcherUrl,
    watcherKey,
    environment: configuredEnv || 'production',
  });
}

export function createErrorPublisher({ watcherUrl, watcherKey, environment }) {
  const endpoint = toEndpoint(watcherUrl);
  const publishError = async event => {
    let payload = event;
    try {
      payload = redactEvent({
        ...event,
        source: { ...event?.source, service: SERVICE, environment },
      });
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-watcher-key': watcherKey,
          'x-watcher-scopes': WATCHER_SCOPES,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
      });
      if (response.ok) return;
    } catch {
      // Network, timeout or unserializable body — the event is spooled below.
    }
    spoolEvent(payload);
  };
  publishError.getDroppedCount = getDroppedCount;
  publishError.getSpool = getSpool;
  return publishError;
}

// C12 ErrorEvent for a gateway failure (OBSERVABILITY-AND-ERROR-CONTRACT.md).
// scope is profile-scoped whenever a chat or user task is known; the reply
// context is the Telegram chat the error is accountable to.
export function buildErrorEvent({
  code,
  operation = null,
  message = '',
  chatId = null,
  userTaskId = null,
  runId = null,
  traceId = null,
  release = 'unknown',
  environment = 'production',
} = {}) {
  const hasChat = chatId != null && chatId !== '';
  const profileId = hasChat ? String(chatId) : (userTaskId ? String(userTaskId) : null);
  return {
    schemaVersion: 1,
    eventId: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    source: { service: SERVICE, release, environment },
    scope: { kind: profileId ? 'profile' : 'platform', tenantId: null, profileId },
    correlation: { userTaskId: userTaskId ?? null, runId: runId ?? null, traceId: traceId ?? null },
    replyContext: {
      channel: 'telegram',
      destinationRef: hasChat ? String(chatId) : null,
      status: hasChat ? 'known' : 'not_applicable',
    },
    error: {
      code,
      operation: operation || code,
      severity: 'error',
      retryable: true,
      outcome: 'failed',
      safeSummary: String(message ?? '').slice(0, SAFE_SUMMARY_MAX),
      privateDetailsRef: null,
    },
    origin: { kind: 'application', incidentId: null, diagnosticDepth: 0 },
  };
}

function toEndpoint(watcherUrl) {
  const base = String(watcherUrl).replace(/\/+$/, '');
  return base.endsWith('/errors') ? base : `${base}/errors`;
}

function spoolEvent(event) {
  spool.push(event);
  if (spool.length > SPOOL_MAX_ENTRIES) spool.shift();
  droppedCount += 1;
}

function redactEvent(event) {
  return redactValue(event);
}

function redactValue(value) {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = SENSITIVE_KEYS.has(String(key).toLowerCase()) ? '[redacted]' : redactValue(entry);
    }
    return out;
  }
  return value;
}

function redactSecrets(text) {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, prefix) => (typeof prefix === 'string' ? `${prefix}[redacted]` : '[redacted]'));
  }
  return out;
}

export default {
  createErrorPublisher,
  resolveErrorPublisher,
  initErrorPublisher,
  activeErrorPublisher,
  buildErrorEvent,
  getDroppedCount,
  getSpool,
};
