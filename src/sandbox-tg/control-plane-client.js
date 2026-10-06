// HTTP adapter of the Telegram sandbox slice to the NEW control plane.
//
// It repeats the calls of the web slice (web/control-plane-client.ts) one to one:
//   POST /intake        (C01, idempotent by requestId)
//   POST /route         (classify the accepted task; Output owns continuation)
//   GET  /receipt       (durable acceptance receipt)
//   POST /start         (start the accepted task; repeat = same instance)
//   POST /signal        (answer in an open awaiting; idempotent by key)
//   POST /status        (read-only view: task, runs, awaiting, history)
//   GET  /events        (C02 journal by cursor; fallback: history of /status)
//   POST /resume        (explicit continuation: new runId, generation+1)
//   POST /connection-lost (outcome unknown, NOT failed)
//   GET  /artifact      (manifest + bytes)
//
// Thin-client rules, same as web:
//  - a lost HTTP response is fixed by REPEATING with the same key, never by a new
//    task and never by a silent rerun;
//  - the client never retries on its own: the caller (ingress/delivery) decides,
//    otherwise "help" becomes a silent rerun;
//  - connection loss is `unknown`, not `failed` (P06);
//  - the key goes only into the Authorization header, never into URL or logs.
import {
  C02_TYPE_BY_KIND,
  C02_TYPE_BY_STATUS_AFTER,
  eventFromHistoryRow,
  hasUnknownOutcome,
  isTerminalTaskStatus,
  normalizeEvent,
  normalizeEventPage,
  numOrNull,
  parseHistoryArray,
  str,
} from './contract.js';
import { logTg } from './log.js';

export class ControlPlaneError extends Error {
  constructor(status, message, body = null) {
    super(message);
    this.name = 'ControlPlaneError';
    this.status = status;
    this.body = body;
  }
}

const asObject = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: String(text ?? '').slice(0, 400) };
  }
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export class ControlPlaneClient {
  constructor(config, options = {}) {
    this.config = config;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.logSink = options.logSink;
    this.transport = null;
  }

  get eventTransport() {
    return this.transport;
  }

  log(fields) {
    logTg(fields, this.logSink);
  }

  /** URL with sanitization: query params are controlled, tokens never go into a URL. */
  url(pathname, query = {}) {
    const url = new URL(`${this.config.controlPlaneUrl}${pathname}`);
    for (const [key, value] of Object.entries(query)) {
      if (value === null || value === undefined || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  headers() {
    const headers = new Headers({ 'content-type': 'application/json' });
    headers.set('x-principal', this.config.principalId);
    if (this.config.principalSignature) headers.set('x-principal-sig', this.config.principalSignature);
    if (this.config.apiKey) headers.set('authorization', `Bearer ${this.config.apiKey}`);
    return headers;
  }

  async request(method, pathname, opts = {}) {
    const url = this.url(pathname, opts.query);
    const timeout = AbortSignal.timeout(this.config.requestTimeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    const res = await this.fetchImpl(url, {
      method,
      headers: this.headers(),
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal,
    });
    const text = await res.text();
    const value = text ? safeJson(text) : null;
    if (!res.ok) {
      throw new ControlPlaneError(res.status, `control plane ${method} ${pathname} -> ${res.status}`, value);
    }
    return { status: res.status, value };
  }

  /** Intake (C01). Repeat with the same requestId = the same receipt. */
  async intake(input) {
    const body = {
      contractVersion: 1,
      requestId: input.requestId,
      profileId: this.config.profileId,
      conversationRef: input.conversationId ?? null,
      sessionId: Object.hasOwn(input, 'sessionId') ? input.sessionId : this.config.sessionId,
      inputItems: input.inputItems ?? [{ text: input.text, artifactRefs: input.artifactRefs ?? [] }],
      waitTimeoutSec: input.waitTimeoutSec ?? null,
    };
    const { status, value } = await this.request('POST', '/intake', { body });
    // A receipt without durable=true violates C01: the slice must not proceed on
    // a task that was not persisted (otherwise "accepted" would be lost).
    if (value?.durable !== true) throw new ControlPlaneError(502, 'intake receipt is not durable', value);
    const receipt = {
      receiptId: String(value.receiptId ?? ''),
      requestId: str(value.requestId),
      userTaskId: String(value.userTaskId ?? ''),
      profileId: String(value.profileId ?? this.config.profileId),
      acceptedAt: numOrNull(value.acceptedAt) ?? Date.now(),
      providerAcceptedAt: Number.isSafeInteger(value.acceptedAt) && value.acceptedAt > 0 ? value.acceptedAt : null,
      durable: true,
      duplicate: value.duplicate === true || status === 200,
    };
    if (!receipt.userTaskId) throw new ControlPlaneError(500, 'intake returned no userTaskId', value);
    this.log({
      event: receipt.duplicate ? 'tg.intake.duplicate' : 'tg.intake.accepted',
      profileId: this.config.profileId,
      userTaskId: receipt.userTaskId,
      requestId: receipt.requestId,
      receiptId: receipt.receiptId,
      reason: receipt.duplicate ? 'idempotent_replay' : 'accepted',
    });
    return receipt;
  }

  async receipt(userTaskId) {
    try {
      const { value } = await this.request('GET', '/receipt', { query: { taskId: userTaskId } });
      return value;
    } catch (e) {
      if (e instanceof ControlPlaneError && e.status === 404) return null;
      throw e;
    }
  }

  /** Start the accepted task: repeat = same instance, a second start is impossible. */
  async start(userTaskId, opts = {}) {
    const { value } = await this.request('POST', '/start', {
      body: {
        taskId: userTaskId,
        profileId: this.config.profileId,
        goal: opts.goal ?? userTaskId,
        question: opts.question ?? null,
        waitTimeoutSec: opts.waitTimeoutSec ?? null,
        crashRunOnce: opts.crashRunOnce ?? false,
      },
    });
    const ack = {
      taskId: str(value.taskId) ?? userTaskId,
      instanceId: str(value.instanceId) ?? userTaskId,
      created: value.created === true,
      instanceCreated: value.instanceCreated === true,
      generation: numOrNull(value.generation) ?? 0,
      runId: str(value.runId),
    };
    this.log({
      event: 'tg.run.start',
      profileId: this.config.profileId,
      userTaskId,
      runId: ack.runId,
      reason: ack.instanceCreated ? 'instance_created' : 'already_started',
      generation: ack.generation,
    });
    return ack;
  }

  async route(userTaskId) {
    const { value } = await this.request('POST', '/route', { body: { taskId: userTaskId, continue: true } });
    return value;
  }

  async cancel(userTaskId, options = {}) {
    const { value } = await this.request('POST', '/cancel', { body: {
      taskId: userTaskId, ...(options.reason ? { reason: options.reason } : {}),
    } });
    return {
      cancelled: value?.cancelled === true,
      stopConfirmed: value?.stopConfirmed === true,
      status: str(value?.status) ?? 'unknown',
      generation: numOrNull(value?.generation),
      nativeStops: Array.isArray(value?.nativeStops) ? value.nativeStops : [],
    };
  }

  /** Durable stop-window reconciliation. Telegram address mapping stays in the gateway. */
  async stopTargets(input) {
    const { value } = await this.request('POST', '/cp-stop-targets', { body: {
      profileId: this.config.profileId,
      conversationId: input.conversationId,
      windowId: input.windowId,
      admissionBarrierComplete: input.admissionBarrierComplete === true,
      admissionRequestIds: input.admissionRequestIds,
      restart: input.restart === true,
    } });
    return {
      snapshotId: str(value?.snapshotId),
      profileId: str(value?.profileId),
      conversationId: str(value?.conversationId),
      tasks: Array.isArray(value?.tasks) ? value.tasks : [],
      unresolved: value?.unresolved !== false,
      reason: str(value?.reason),
      stopConfirmed: value?.stopConfirmed === true,
    };
  }

  /** Signal (human answer in an open awaiting). The idempotency key is mandatory. */
  async signal(userTaskId, input) {
    const { value } = await this.request('POST', '/signal', {
      body: {
        taskId: userTaskId,
        type: input.type,
        payload: input.payload,
        idempotencyKey: input.idempotencyKey,
        source: input.source ?? 'telegram',
      },
    });
    const ack = {
      delivered: value.delivered === true,
      signalId: numOrNull(value.signalId) ?? 0,
      duplicate: value.duplicate === true,
      reason: str(value.reason) ?? undefined,
    };
    this.log({
      event: ack.delivered ? 'tg.signal.delivered' : 'tg.signal.not_delivered',
      profileId: this.config.profileId,
      userTaskId,
      requestId: input.idempotencyKey,
      reason: ack.reason ?? (ack.duplicate ? 'idempotent_replay' : 'delivered'),
      duplicate: ack.duplicate,
    });
    return ack;
  }

  /** Status — read only (P05): no step, no rerun. */
  async status(userTaskId, options = {}) {
    const { value } = await this.request('POST', '/status', { body: { taskId: userTaskId }, signal: options.signal });
    const row = asObject(value.taskStore);
    const runs = Array.isArray(value.runs) ? value.runs : [];
    return {
      id: str(row.id) ?? userTaskId,
      status: str(row.status) ?? 'unknown',
      stage: str(row.stage),
      generation: numOrNull(row.generation) ?? 0,
      revision: numOrNull(row.revision) ?? 0,
      result: row.result ?? null,
      conversation_id: str(row.conversation_id),
      delivery_state: str(row.delivery_state),
      awaiting: parseAwaiting(row.awaiting),
      runs: runs.map(run => ({
        id: String(run.id ?? ''),
        status: str(run.status) ?? 'unknown',
        generation: numOrNull(run.generation) ?? 0,
        started_at: numOrNull(run.started_at),
        finished_at: numOrNull(run.finished_at),
        error_class: str(run.error_class),
        lease_until: numOrNull(run.lease_until),
      })),
      updated_at: numOrNull(row.updated_at),
    };
  }

  /**
   * Journal page AFTER the cursor. Main path — C02 `/events?after=`. If the
   * endpoint is missing in this build of the plane, the same table is read from
   * the `/status` history and the transport is recorded in the log.
   */
  async events(userTaskId, after, limit = 200) {
    if (this.config.eventTransport === 'status-history') return this.eventsFromStatus(userTaskId, after, limit);
    try {
      const { value } = await this.request('GET', '/events', {
        query: { taskId: userTaskId, after: after ?? 0, limit },
      });
      const page = normalizeEventPage(value);
      this.noteTransport('events-endpoint', null);
      return page;
    } catch (e) {
      const unavailable = e instanceof ControlPlaneError && (e.status === 404 || e.status === 405);
      if (!unavailable || this.config.eventTransport === 'events-endpoint') throw e;
      this.noteTransport('status-history', `events_endpoint_${e instanceof ControlPlaneError ? e.status : 'error'}`);
      return this.eventsFromStatus(userTaskId, after, limit);
    }
  }

  noteTransport(transport, reason) {
    if (this.transport === transport) return;
    this.transport = transport;
    this.log({ event: 'tg.events.transport', profileId: this.config.profileId, transport, reason });
  }

  /** Fallback journal read: `/status` returns the same event table (`history`). */
  async eventsFromStatus(userTaskId, after, limit) {
    const { value } = await this.request('POST', '/status', { body: { taskId: userTaskId } });
    const row = asObject(value.taskStore);
    const history = parseHistoryArray(row.history);
    const events = history
      .map(entry => eventFromHistoryRow(entry, userTaskId))
      .filter(event => event.sequence > (after ?? 0))
      .sort((a, b) => a.sequence - b.sequence)
      .slice(0, limit);
    const last = events.length ? events[events.length - 1].sequence : after;
    this.noteTransport('status-history', this.transport === 'status-history' ? null : 'fallback_enabled');
    return { events, nextCursor: last, hasMore: false };
  }

  /** Explicit continuation after a lost connection: NEW runId, generation+1. */
  async resume(userTaskId, opts) {
    const { value } = await this.request('POST', '/resume', {
      body: { taskId: userTaskId, reason: opts.reason, instructions: opts.instructions },
    });
    const ack = { runId: str(value.runId) ?? '', generation: numOrNull(value.generation) ?? 0 };
    this.log({
      event: 'tg.run.resumed',
      profileId: this.config.profileId,
      userTaskId,
      runId: ack.runId,
      reason: opts.reason,
      generation: ack.generation,
    });
    return ack;
  }

  /** Wake interrupted instances after a restart of the plane (`/recover`). */
  async recover() {
    const { value } = await this.request('POST', '/recover', { body: {} });
    return value;
  }

  /** Connection lost with the executor: attempt `unknown`, task unchanged. */
  async markConnectionLost(runId, reason = 'connection_lost') {
    const { value } = await this.request('POST', '/connection-lost', { body: { runId, reason } });
    this.log({ event: 'tg.run.connection_lost', runId, reason });
    return value;
  }

  /** Artifact bytes. The plane returns a manifest; the byte source is its own deal. */
  async artifact(userTaskId, ref) {
    const { value } = await this.request('GET', '/artifact', { query: { taskId: userTaskId, ref } });
    const body = value.bodyBase64;
    return {
      ref: str(value.ref) ?? ref,
      sizeBytes: numOrNull(value.sizeBytes),
      sha256: str(value.sha256),
      contentType: str(value.contentType),
      body: typeof body === 'string' ? base64ToBytes(body) : new Uint8Array(),
    };
  }

  /** Is the plane alive: cheap auth + configuration check. */
  async health() {
    const { value } = await this.request('GET', '/');
    return value;
  }
}

function parseAwaiting(value) {
  const row = asObject(value);
  const id = str(row.id);
  if (!id) return null;
  return {
    id,
    status: str(row.status) ?? 'open',
    deadline: numOrNull(row.deadline),
    question: str(row.question),
  };
}

export { hasUnknownOutcome, isTerminalTaskStatus, normalizeEvent, C02_TYPE_BY_KIND, C02_TYPE_BY_STATUS_AFTER };

export default ControlPlaneClient;
