// Contract of the new control plane as consumed by the Telegram sandbox slice
// (card P11 of epic #20, step 7/7-equivalent of #109).
//
// This is the SAME HTTP surface the web slice consumes (control plane `web/`
// slice, contract.ts + control-plane-client.ts, PR #11/#17). The Telegram slice
// is a second, independent adapter: it repeats the calls of the web slice
// (POST /intake + requestId, POST /start, POST /signal + idempotencyKey,
// POST /status, GET /events?after=, POST /resume, GET /artifact) and never the
// legacy agent API. Nothing here imports control-plane internals — the contract
// must survive refactors inside the plane.
//
// Correspondence: C01 intake/receipt, C02 event envelope with cursor, C03
// principal + scope, A2 §6 terminal states and attempts (runId/generation).

/** Contract version of intake this slice speaks (matches C01). */
export const INTAKE_CONTRACT_VERSION = 1;

/** Terminal task statuses: past them there is no second run without an explicit act. */
export const TERMINAL_TASK_STATUSES = ['done', 'failed', 'cancelled'];

/** Attempt status that means "outcome lost", NOT "failed" (P06). */
export const UNKNOWN_ATTEMPT_STATUS = 'unknown';

/** Telegram's own upload ceiling for bots (U-08 / PR-13). */
export const TELEGRAM_FILE_SIZE_LIMIT_BYTES = 20 * 1024 * 1024;

export function isTerminalTaskStatus(status) {
  return TERMINAL_TASK_STATUSES.includes(status);
}

/**
 * Outcome of an attempt is unknown (connection lost). The task is NOT failed
 * and must not be re-run automatically — only an explicit user action resumes it.
 */
export function hasUnknownOutcome(status) {
  return (
    Array.isArray(status?.runs) &&
    status.runs.some(run => run?.status === UNKNOWN_ATTEMPT_STATUS) &&
    !isTerminalTaskStatus(status?.status)
  );
}

/** Normalizes one C02 event envelope; tolerant about where a field came from. */
export function normalizeEvent(raw, defaults = {}) {
  const event = raw && typeof raw === 'object' ? raw : {};
  const payload = isPlainObject(event.payload) ? event.payload : {};
  return {
    eventId: typeof event.eventId === 'string' ? event.eventId : null,
    sequence: Number.isFinite(event.sequence) ? Number(event.sequence) : 0,
    userTaskId: typeof event.userTaskId === 'string' ? event.userTaskId : defaults.userTaskId ?? '',
    runId: typeof event.runId === 'string' ? event.runId : typeof payload.runId === 'string' ? payload.runId : null,
    type: typeof event.type === 'string' ? event.type : typeof event.kind === 'string' ? event.kind : 'progress',
    occurredAt: Number.isFinite(event.occurredAt) ? Number(event.occurredAt) : 0,
    payload,
    artifactRefs: Array.isArray(event.artifactRefs) ? event.artifactRefs.filter(ref => typeof ref === 'string') : [],
    kind: typeof event.kind === 'string' ? event.kind : typeof event.type === 'string' ? event.type : 'progress',
  };
}

export function normalizeEventPage(value) {
  const row = isPlainObject(value) ? value : {};
  const events = Array.isArray(row.events) ? row.events : [];
  return {
    events: events.map(event => normalizeEvent(event)),
    nextCursor: Number.isFinite(row.nextCursor) ? Number(row.nextCursor) : null,
    hasMore: row.hasMore === true,
  };
}

/** Terminal → user-facing outcome label. Unknown outcome is NOT a failure. */
export const TERMINAL_OUTCOME_LABEL = {
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
};

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function str(value) {
  return typeof value === 'string' ? value : null;
}

export function numOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * kind → C02 type vocabulary of the control plane
 * (src/events/c02-event-envelope.ts). Kept here so the projection never has to
 * know which transport the journal was read from.
 */
export const C02_TYPE_BY_KIND = {
  task_accepted: 'accepted',
  run_started: 'started',
  run_finished: 'progress',
  awaiting_opened: 'waiting',
  awaiting_answered: 'progress',
  awaiting_expired: 'progress',
  signal_received: 'progress',
  signal_rejected: 'progress',
  step_woken: 'progress',
  step_started: 'progress',
  step_done: 'progress',
  step_failed: 'attempt_failed',
  result_ready: 'result_ready',
  task_cancelled: 'stopped',
  cancel_requested: 'progress',
  fenced: 'progress',
  error: 'progress',
  task_status_changed: 'progress',
};

export const C02_TYPE_BY_STATUS_AFTER = {
  done: 'result_ready',
  failed: 'task_failed',
  cancelled: 'stopped',
};

/**
 * Journal row from the `/status` history fallback into the same C02 envelope.
 * In `/status` the history arrives as a JSON string (json_group_array) and the
 * monotonic `id` IS the cursor.
 */
export function eventFromHistoryRow(raw, userTaskId = '') {
  const row = isPlainObject(raw) ? raw : {};
  let payload = {};
  if (typeof row.payload === 'string' && row.payload) {
    try {
      payload = isPlainObject(JSON.parse(row.payload)) ? JSON.parse(row.payload) : {};
    } catch {
      payload = {};
    }
  } else {
    payload = isPlainObject(row.payload) ? row.payload : {};
  }
  const kind = str(row.kind) ?? 'progress';
  const statusAfter = str(row.after);
  const type = C02_TYPE_BY_KIND[kind] ?? (statusAfter ? C02_TYPE_BY_STATUS_AFTER[statusAfter] ?? 'progress' : 'progress');
  return normalizeEvent(
    {
      eventId: null,
      sequence: numOrNull(row.id) ?? 0,
      userTaskId,
      runId: str(payload.runId),
      type,
      occurredAt: numOrNull(row.at) ?? 0,
      payload: { ...payload, step: str(row.step) },
      artifactRefs: Array.isArray(payload.artifactRefs) ? payload.artifactRefs : [],
      kind,
    },
    { userTaskId },
  );
}

/** Parses the `history` column, which may be an array or a JSON string. */
export function parseHistoryArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

export default {
  INTAKE_CONTRACT_VERSION,
  TERMINAL_TASK_STATUSES,
  UNKNOWN_ATTEMPT_STATUS,
  TELEGRAM_FILE_SIZE_LIMIT_BYTES,
  isTerminalTaskStatus,
  hasUnknownOutcome,
  normalizeEvent,
  normalizeEventPage,
  eventFromHistoryRow,
  parseHistoryArray,
};