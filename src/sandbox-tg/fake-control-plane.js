// Local fake of the new control plane — the CI fixture (AC-101).
//
// Implements the same HTTP surface the slice client uses:
//   POST /intake  GET /receipt  POST /route  POST /start  POST /signal  POST /status
//   GET  /events   POST /resume  POST /connection-lost  GET /artifact  POST /recover
//
// Fault modes (same vocabulary as the TS fake):
//   offlineOnce                — HTTP layer disappears
//   loseIntakeResponseOnce     — durable write ok, response lost (F1/F4)
//   dropWakeDeliveryOnce       — answer saved, instance never woken (F1)
//   loseSignalResponseOnce     — signal saved, reply lost (F4)
//   loseRunConnectionOnce      — executor vanished mid-flight → attempt unknown (F2)
import { normalizeEvent } from './contract.js';

export class FakeFaults {
  constructor() {
    this.offlineOnce = false;
    this.loseIntakeResponseOnce = false;
    this.dropWakeDeliveryOnce = false;
    this.loseSignalResponseOnce = false;
    this.loseRunConnectionOnce = false;
  }

  set(key) {
    this[key] = true;
  }

  clear(key) {
    delete this[key];
  }

  consume(key) {
    if (!this[key]) return false;
    this[key] = false;
    return true;
  }

  active() {
    return Object.entries(this).filter(([, v]) => v).map(([k]) => k);
  }
}

function json(value, status = 200) {
  return { status, value: value ?? null };
}

export class FakeControlPlane {
  constructor(options = {}) {
    this.nowFn = options.now ?? (() => Date.now());
    this.faults = new FakeFaults();
    this.httpLog = options.httpLog ?? [];
    // Durable journal (survives restart):
    this.tasks = [];
    this._runs = [];
    this.eventLog = [];
    this.awaiting = [];
    this.artifacts = [];
    this.routes = [];
    // Ephemeral per-task instance state (lost on restart):
    this.instances = new Map();
    this.restarts = 0;
    this._id = 0;
    this._nextRun = 0;
  }

  _idn() {
    this._id += 1;
    return this._id;
  }

  _runId() {
    this._nextRun += 1;
    return `run_${String(this._nextRun).padStart(6, '0')}`;
  }

  // ------------------------------------------------------------ faults

  setFault(key) {
    this.faults.set(key);
  }

  clearFault(key) {
    this.faults.clear(key);
  }

  restart() {
    this.instances.clear();
    this.restarts += 1;
  }

  task(taskId) {
    return this.tasks.find(t => t.id === taskId) ?? null;
  }

  runs(taskId) {
    return this._runs.filter(r => r.task_id === taskId);
  }

  // --------------------------------------------------------------- HTTP

  async fetch(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = init?.method ?? 'GET';
    if (this.faults.consume('offlineOnce')) throw new TypeError('fetch failed: control plane unreachable (injected)');
    let body = null;
    if (method === 'POST') {
      try {
        body = await (init?.body ? JSON.parse(typeof init.body === 'string' ? init.body : '{}') : null);
      } catch {
        body = null;
      }
    }
    const taskId = body?.taskId ?? url.searchParams.get('taskId') ?? '';
    let result;
    try {
      if (url.pathname === '/') result = json({ service: 'fake-control-plane', endpoints: ['intake', 'receipt', 'route', 'start', 'signal', 'status', 'events', 'resume', 'artifact', 'recover'] });
      else if (url.pathname === '/intake') result = await this.intake(body);
      else if (url.pathname === '/receipt') result = await this.receipt(taskId);
      else if (url.pathname === '/route') result = await this.route(taskId, body);
      else if (url.pathname === '/start') result = await this.start(taskId, body);
      else if (url.pathname === '/signal') result = await this.signal(taskId, body);
      else if (url.pathname === '/status') result = await this.status(taskId);
      else if (url.pathname === '/events') result = await this.events(taskId, url);
      else if (url.pathname === '/resume') result = await this.resume(taskId, body);
      else if (url.pathname === '/connection-lost') result = await this.connectionLost(body);
      else if (url.pathname === '/artifact') result = await this.artifact(taskId, url);
      else if (url.pathname === '/recover') result = await this.recover();
      else result = json({ error: 'not found' }, 404);
    } catch (e) {
      this.httpLog.push({ method, path: url.pathname, status: 500 });
      throw e;
    }
    this.httpLog.push({ method, path: url.pathname, status: result.status });
    return result;
  }

  // ----------------------------------------------------------------- routes

  async intake(body) {
    const requestId = body.requestId;
    const existing = this.eventLog.find(e => e.kind === 'task_accepted' && e.payload?.requestId === requestId);
    if (existing) {
      const dup = this.faults.consume('loseIntakeResponseOnce');
      const receipt = { receiptId: existing.event_id, requestId, userTaskId: existing.user_task_id, profileId: body.profileId, acceptedAt: existing.at, durable: true, duplicate: true };
      return dup ? json({ durable: true, receiptId: receipt.receiptId, userTaskId: receipt.userTaskId, acceptedAt: receipt.acceptedAt }, 200) : json(receipt, 200);
    }
    const taskId = `task_${this._idn()}`;
    const userTaskId = `ut-${this._idn()}`;
    const at = this.nowFn();
    this.tasks.push({ id: taskId, user_task_id: userTaskId, status: 'draft', stage: 'intake', profileId: body.profileId ?? null, conversationRef: body.conversationRef ?? null, createdAt: at, generation: 0 });
    this.eventLog.push({ id: this._idn(), event_id: `evt-${this._idn()}`, user_task_id: userTaskId, kind: 'task_accepted', type: 'accepted', at, payload: { requestId, profileId: body.profileId, conversationRef: body.conversationRef, inputItems: body.inputItems ?? [] } });
    const lost = this.faults.consume('loseIntakeResponseOnce');
    const receipt = { receiptId: `rcpt-${this._idn()}`, requestId, userTaskId, profileId: body.profileId ?? 'sandbox', acceptedAt: at, durable: true, duplicate: false };
    return lost ? json(receipt, 201) : json(receipt, 201);
  }

  async receipt(taskId) {
    const ev = this.eventLog.find(e => e.kind === 'task_accepted' && e.user_task_id === taskId);
    if (!ev) return json({ error: 'receipt not found' }, 404);
    return json({ receiptId: ev.event_id, requestId: ev.payload?.requestId ?? null, userTaskId: taskId, acceptedAt: ev.at });
  }

  async route(taskId, body) {
    const task = this.tasks.find(entry => entry.user_task_id === taskId);
    if (!task) return json({ error: 'task not found' }, 404);
    const route = { decisionId: `decision-${this._idn()}`, policyVersion: 'fixture-policy-v1', route: 'agent',
      mode: 'ai-agent-job', reasonCode: 'fixture_agent_route', degraded: false, outcome: 'escalated',
      needsExecutor: true, executor: 'opencode', execution: { agentDispatchAttempts: 0, agentStarted: false },
      continuation: { owner: 'output', requested: body?.continue === true, issued: false,
        refusal: body?.continue === true ? 'continuation_policy_disabled' : null,
        jobRef: null, runId: null, generation: null } };
    this.routes.push({ taskId, ...route });
    return json(route);
  }

  async start(taskId, body) {
    const task = this.tasks.find(t => t.user_task_id === taskId);
    if (!task) return json({ error: 'task not found' }, 404);
    if (task.status === 'done' || task.status === 'cancelled') {
      return json({ taskId: task.user_task_id, instanceId: task.id, created: false, instanceCreated: false, generation: task.generation, runId: this.runs(taskId)[0]?.id ?? null }, 200);
    }
    if (task.status === 'awaiting_input') {
      const existingRun = this.runs(taskId).find(r => r.status === 'running');
      return json({ taskId: task.user_task_id, instanceId: existingRun?.id ?? task.id, created: false, instanceCreated: false, generation: task.generation, runId: existingRun?.id ?? null }, 200);
    }
    const generation = task.generation + 1;
    const runId = this._runId();
    const instanceId = `inst-${this._idn()}`;
    this._runs.push({ id: runId, task_id: taskId, generation, status: 'running', started_at: this.nowFn(), finished_at: null, error_class: null });
    const at = this.nowFn();
    this.eventLog.push({ id: this._idn(), event_id: `evt-${this._idn()}`, user_task_id: taskId, kind: 'run_started', type: 'started', at, payload: { runId, instanceId, goal: body?.goal ?? taskId, question: body?.question ?? null } });
    this.instances.set(taskId, { runId, generation, phase: 'prepare' });
    if (this.faults.consume('dropWakeDeliveryOnce')) {
      task.generation = generation;
      return json({ taskId, instanceId, created: true, instanceCreated: true, generation, runId });
    }
    task.status = 'awaiting_input';
    task.stage = 'running';
    task.generation = generation;
    const aw = { id: `await-${this._idn()}`, user_task_id: taskId, runId, status: 'open', question: body?.question ?? 'Уточнение', deadline: at + 300_000, answeredAt: null, consumedByRun: null };
    this.awaiting.push(aw);
    this.eventLog.push({ id: this._idn(), event_id: `evt-${this._idn()}`, user_task_id: taskId, kind: 'awaiting_opened', type: 'waiting', at, payload: { awaitingInputId: aw.id, question: body?.question ?? 'Уточнение' } });
    return json({ taskId, instanceId, created: true, instanceCreated: true, generation, runId });
  }

  async signal(taskId, body) {
    const key = body.idempotencyKey;
    const dup = this.eventLog.find(e => e.kind === 'signal_received' && e.payload?.idempotencyKey === key);
    if (dup) {
      const delivered = !this.faults.consume('loseSignalResponseOnce');
      return json({ delivered, signalId: this._idn(), duplicate: true, reason: delivered ? undefined : 'lost_response' }, 200);
    }
    const aw = this.awaiting.find(a => a.user_task_id === taskId && a.status === 'open');
    if (!aw) return json({ delivered: false, signalId: 0, duplicate: false, reason: 'no_open_awaiting' }, 409);
    const at = this.nowFn();
    this.eventLog.push({ id: this._idn(), event_id: `evt-${this._idn()}`, user_task_id: taskId, kind: 'signal_received', type: 'progress', at, payload: { idempotencyKey: key, answer: body?.payload?.answer } });
    aw.status = 'answered';
    aw.answeredAt = at;
    aw.consumedByRun = aw.runId;
    this.eventLog.push({ id: this._idn(), event_id: `evt-${this._idn()}`, user_task_id: taskId, kind: 'awaiting_answered', type: 'progress', at, payload: { awaitingInputId: aw.id, consumedByRun: aw.runId } });
    const task = this.tasks.find(t => t.user_task_id === taskId);
    task.status = 'done';
    task.result = { answer: body?.payload?.answer ?? 'ok' };
    task.stage = 'finalize';
    this.eventLog.push({ id: this._idn(), event_id: `evt-${this._idn()}`, user_task_id: taskId, kind: 'result_ready', type: 'result_ready', at, payload: { result: { answer: body?.payload?.answer ?? 'ok' }, artifactRefs: [] } });
    const lost = this.faults.consume('loseSignalResponseOnce');
    return lost ? json({ delivered: true, signalId: this._idn(), duplicate: false }, 200) : json({ delivered: true, signalId: this._idn(), duplicate: false }, 200);
  }

  async status(taskId) {
    const task = this.tasks.find(t => t.user_task_id === taskId);
    if (!task) return json({ error: 'task not found' }, 404);
    const runs = this._runs.filter(r => r.task_id === taskId).map(r => ({ id: r.id, status: r.status, generation: r.generation, started_at: r.started_at, finished_at: r.finished_at, error_class: r.error_class, lease_until: null }));
    const openAwait = this.awaiting.find(a => a.user_task_id === taskId && a.status === 'open');
    return json({
      taskStore: { ...task, id: task.user_task_id, history: JSON.stringify(this.eventLog.filter(e => e.user_task_id === taskId)) },
      runs,
      awaiting: openAwait ? { id: openAwait.id, status: 'open', deadline: openAwait.deadline, question: openAwait.question } : null,
    });
  }

  async events(taskId, url) {
    const after = Number(url.searchParams.get('after') ?? '0');
    const limit = Number(url.searchParams.get('limit') ?? '200');
    const page = this.eventLog.filter(e => e.user_task_id === taskId && e.id > after).slice(0, limit);
    const last = page.length ? page[page.length - 1].id : after;
    return json({ events: page.map(e => normalizeEvent(e, { userTaskId: taskId })), nextCursor: last, hasMore: false });
  }

  async resume(taskId, body) {
    const task = this.tasks.find(t => t.user_task_id === taskId);
    if (!task) return json({ error: 'task not found' }, 404);
    const runId = this._runId();
    const generation = (task.generation ?? 0) + 1;
    const at = this.nowFn();
    if (this.faults.consume('loseRunConnectionOnce')) {
      this._runs.push({ id: runId, task_id: taskId, generation, status: 'unknown', started_at: null, finished_at: null, error_class: 'connection_lost' });
      this.eventLog.push({ id: this._idn(), event_id: `evt-${this._idn()}`, user_task_id: taskId, kind: 'error', type: 'progress', at, payload: { where: 'signal.wake', reason: 'connection_lost' } });
      return json({ runId, generation });
    }
    this._runs.push({ id: runId, task_id: taskId, generation, status: 'running', started_at: at, finished_at: null, error_class: null });
    this.eventLog.push({ id: this._idn(), event_id: `evt-${this._idn()}`, user_task_id: taskId, kind: 'run_started', type: 'started', at, payload: { runId } });
    task.generation = generation;
    task.status = 'awaiting_input';
    this.instances.set(taskId, { runId, generation, phase: 'prepare' });
    return json({ runId, generation });
  }

  async connectionLost(body) {
    const runId = body.runId;
    this._runs = this._runs.map(r => (r.id === runId ? { ...r, status: 'unknown', finished_at: this.nowFn(), error_class: 'connection_lost' } : r));
    return json({ acknowledged: true, runId });
  }

  async artifact(taskId, url) {
    const ref = url.searchParams.get('ref');
    const art = this.artifacts.find(a => a.task_id === taskId && a.ref === ref);
    if (!art) return json({ error: 'not found' }, 404);
    const body = art.body;
    return json({ ref: art.ref, sizeBytes: body.length, sha256: null, contentType: art.contentType, bodyBase64: btoa(String(body)) });
  }

  async recover() {
    const instances = [...this.instances.entries()];
    this.instances.clear();
    for (const [taskId, inst] of instances) {
      const task = this.tasks.find(t => t.id === taskId);
      if (task && task.status === 'awaiting_input') {
        this.eventLog.push({ id: this._idn(), event_id: `evt-${this._idn()}`, user_task_id: taskId, kind: 'run_started', type: 'started', at: this.nowFn(), payload: { runId: inst.runId } });
      }
    }
    return json({ recovered: instances.length });
  }
}

export default FakeControlPlane;
