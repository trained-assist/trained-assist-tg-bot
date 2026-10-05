// The conversation as the unit of work of the Telegram slice — the exact
// counterpart of web/conversation.ts, with Telegram's own idempotency keys.
//
// Principles (identical to the web slice):
//  1. The control plane is the source of truth. The slice keeps only a durable
//     conversation index (KV) and read cursors; the view is a pure fold of the
//     journal, so a restart of the slice OR of the plane loses and re-runs
//     nothing: a cold session rebuilds the view from cursor 0.
//  2. Idempotency keys are deterministic from the message number
//     (`tg:<conversation>:m<N>`): a double tap, a redelivered webhook or a lost
//     HTTP response returns the same receipt and the same signal — never a
//     second task and never a second wake-up.
//  3. No automatic rerun. A lost connection is `unknown`, not `failed` (P06);
//     continuation is an explicit user action only.
import { hasUnknownOutcome, isTerminalTaskStatus } from './contract.js';
import { ControlPlaneError } from './control-plane-client.js';
import { logTg } from './log.js';

export const messageKey = (conversationId, seq) => `tg:${conversationId}:m${seq}`;

export class ConversationNotFoundError extends Error {
  constructor(conversationId) {
    super(`conversation ${conversationId} is unknown to this sandbox slice`);
    this.name = 'ConversationNotFoundError';
  }
}

export class NoAwaitingInputError extends Error {
  constructor(conversationId) {
    super(`conversation ${conversationId} has no open awaiting input`);
    this.name = 'NoAwaitingInputError';
  }
}

export class ConversationIndex {
  constructor(conversationId, profileId) {
    this.conversationId = conversationId;
    this.profileId = profileId;
    this.turns = [];
    this.cursors = {};
  }
}

/** Durable index store: KV in the Worker, memory in tests. Narrow on purpose. */
export class KvConversationStore {
  constructor(kv) {
    this.kv = kv;
  }

  key(conversationId) {
    return `conv:${conversationId}`;
  }

  async load(conversationId) {
    const raw = await this.kv.get(this.key(conversationId));
    if (!raw) return null;
    try {
      const value = JSON.parse(raw);
      return value && typeof value === 'object' ? value : null;
    } catch {
      return null;
    }
  }

  async save(index) {
    await this.kv.put(this.key(index.conversationId), JSON.stringify(index));
  }
}

export class MemoryConversationStore {
  constructor() {
    this.data = new Map();
  }

  async load(conversationId) {
    const found = this.data.get(conversationId);
    return found ? structuredClone(found) : null;
  }

  async save(index) {
    this.data.set(index.conversationId, structuredClone(index));
  }

  /** Snapshot/restore — emulates a process restart with durable KV intact. */
  snapshot() {
    return [...this.data.values()].map(value => structuredClone(value));
  }

  restore(items) {
    this.data.clear();
    for (const item of items) this.data.set(item.conversationId, structuredClone(item));
  }
}

export class ConversationSession {
  constructor(client, options) {
    this.client = client;
    this.store = options.store;
    this.profileId = options.profileId;
    this.maxTurns = options.maxTurns ?? 64;
    this.logSink = options.logSink;
    this.index = null;
    this.projections = new Map();
    this.conversationId = options.conversationId;
  }

  log(fields) {
    logTg(fields, this.logSink);
  }

  async requireIndex() {
    if (this.index) return this.index;
    const stored = await this.store.load(this.conversationId);
    if (!stored) throw new ConversationNotFoundError(this.conversationId);
    this.index = stored;
    return stored;
  }

  /** Create a conversation: an empty durable index. No task exists yet. */
  async create() {
    const index = new ConversationIndex(this.conversationId, this.profileId);
    await this.store.save(index);
    this.index = index;
    this.log({ event: 'tg.conversation.created', conversationId: index.conversationId, profileId: index.profileId });
    return this.refresh();
  }

  /** Open a conversation: index from durable storage + journal replay by cursor. */
  async open() {
    await this.requireIndex();
    return this.refresh();
  }

  /**
   * New user message: intake (C01) + start of the accepted task. A repeat of the
   * same seq returns the same receipt and never starts a second run.
   */
  async sendMessage(text, seq = null, inputItems = null, ingressRequestId = null) {
    const index = await this.requireIndex();
    const existing = ingressRequestId
      ? index.turns.find(turn => turn.requestId === ingressRequestId)
      : index.turns.find(turn => turn.seq === seq);
    const target = existing?.seq ?? seq ?? index.turns.length + 1;
    if (target > this.maxTurns && !this.client.config?.routeBeforeStart) throw new Error(`conversation ${index.conversationId} reached maxTurns=${this.maxTurns}`);
    const requestId = ingressRequestId ?? existing?.requestId ?? messageKey(index.conversationId, target);
    const receipt = await this.client.intake({
      requestId,
      text,
      conversationId: index.conversationId,
      inputItems: inputItems ?? undefined,
    });
    const started = await this.startOrKeepTerminal(receipt.userTaskId, text);
    if (!existing) {
      index.turns.push({
        seq: target,
        conversationId: index.conversationId,
        kind: 'new',
        requestId,
        userTaskId: receipt.userTaskId,
        text,
        inputItemCount: (inputItems ?? [{ text }]).length,
        createdAt: receipt.acceptedAt,
      });
      await this.store.save(index);
    }
    this.log({
      event: receipt.duplicate ? 'tg.conversation.message_duplicate' : 'tg.conversation.message',
      conversationId: index.conversationId,
      userTaskId: receipt.userTaskId,
      requestId,
      reason: receipt.duplicate ? 'idempotent_replay' : started ? 'started' : 'already_terminal',
      started,
      inputItemCount: (inputItems ?? [{ text }]).length,
    });
    return {
      seq: target,
      requestId,
      userTaskId: receipt.userTaskId,
      receiptId: receipt.receiptId,
      duplicate: receipt.duplicate,
      started,
      view: await this.refresh(),
    };
  }

  /**
   * Human answer in an open awaiting. The key is deterministic from the message
   * number, so a double send creates no second signal and wakes nothing twice.
   */
  async answer(text, seq = null) {
    const index = await this.requireIndex();
    const awaiting = (await this.refresh()).awaiting;
    if (!awaiting) throw new NoAwaitingInputError(index.conversationId);
    const target = seq ?? index.turns.length + 1;
    const requestId = messageKey(index.conversationId, target);
    const ack = await this.client.signal(awaiting.userTaskId, {
      type: 'user_reply',
      payload: { answer: text },
      idempotencyKey: requestId,
    });
    const existing = index.turns.find(turn => turn.seq === target);
    if (!existing) {
      index.turns.push({
        seq: target,
        conversationId: index.conversationId,
        kind: 'answer',
        requestId,
        userTaskId: awaiting.userTaskId,
        text,
        createdAt: Date.now(),
      });
      await this.store.save(index);
    }
    this.log({
      event: 'tg.conversation.answer',
      conversationId: index.conversationId,
      userTaskId: awaiting.userTaskId,
      requestId,
      reason: ack.duplicate ? 'idempotent_replay' : (ack.reason ?? (ack.delivered ? 'delivered' : 'not_delivered')),
    });
    return {
      seq: target,
      requestId,
      userTaskId: awaiting.userTaskId,
      delivered: ack.delivered,
      duplicate: ack.duplicate,
      view: await this.refresh(),
    };
  }

  /** Explicit continuation after a lost connection: NEW runId, generation+1. */
  async continueUnknown(seq, instructions = null) {
    const index = await this.requireIndex();
    const turn = index.turns.find(entry => entry.seq === seq);
    if (!turn) throw new ConversationNotFoundError(`${index.conversationId}#${seq}`);
    const ack = await this.client.resume(turn.userTaskId, {
      reason: 'explicit_user_continuation',
      instructions,
    });
    this.log({
      event: 'tg.conversation.continuation',
      conversationId: index.conversationId,
      userTaskId: turn.userTaskId,
      runId: ack.runId,
      reason: 'explicit_user_continuation',
      generation: ack.generation,
    });
    return { seq, userTaskId: turn.userTaskId, runId: ack.runId, generation: ack.generation, view: await this.refresh() };
  }

  /** Wake interrupted plane instances after a restart (`/recover`). */
  async recover() {
    return this.client.recover();
  }

  /**
   * Rebuild the view: journal pages after the cursor per task, then a read-only
   * status. No step of the plane, no rerun — ever.
   */
  async refresh() {
    const index = await this.requireIndex();
    const turns = [];
    for (const entry of index.turns) {
      // A cold session (restart of the slice or first request) rebuilds from 0;
      // the cursor is only an optimization of a warm session.
      const cold = !this.projections.has(entry.userTaskId);
      const projection = this.projectionFor(entry.userTaskId);
      let page = await this.client.events(entry.userTaskId, cold ? 0 : (index.cursors[entry.userTaskId] ?? 0));
      while (true) {
        projection.apply(page.events);
        if (!page.hasMore) break;
        page = await this.client.events(entry.userTaskId, page.nextCursor ?? projection.cursor);
      }
      const status = await this.client.status(entry.userTaskId);
      projection.applyStatus(status);
      index.cursors[entry.userTaskId] = projection.cursor;
      turns.push(projection.view(entry, this.client.eventTransport));
    }
    await this.store.save(index);

    const awaiting = awaitingTurnOf(index.turns, turns);
    const artifacts = turns.flatMap(turn =>
      turn.artifacts.map(artifact => ({ seq: turn.seq, userTaskId: turn.userTaskId, ref: artifact.ref, url: artifact.url })),
    );
    const unknownOutcomeTurns = turns.filter(turn => turn.unknownOutcome);
    return {
      conversationId: index.conversationId,
      profileId: index.profileId,
      transport: this.client.eventTransport,
      turns,
      awaiting,
      unknownOutcomeTurns,
      artifacts,
      nextSeq: index.turns.length + 1,
    };
  }

  async currentAwaiting() {
    const index = await this.requireIndex();
    const view = await this.refresh();
    return view.awaiting ?? awaitingTurnOf(index.turns, view.turns);
  }

  projectionFor(userTaskId) {
    const existing = this.projections.get(userTaskId);
    if (existing) return existing;
    const created = new TaskProjection(userTaskId, 0);
    this.projections.set(userTaskId, created);
    return created;
  }

  async startOrKeepTerminal(userTaskId, goal) {
    try {
      if (this.client.config?.routeBeforeStart) {
        const routed = await this.client.route(userTaskId);
        this.log({ event: 'tg.conversation.routed', userTaskId, reason: routed.reasonCode ?? routed.route });
        return routed.continuation?.issued === true || routed.execution?.agentStarted === true;
      }
      const ack = await this.client.start(userTaskId, { goal, question: `Уточнение по задаче: ${String(goal).slice(0, 120)}` });
      return ack.instanceCreated || ack.runId !== null;
    } catch (e) {
      // A terminal task is restarted only by an explicit new message.
      if (e instanceof ControlPlaneError && e.status === 409) {
        this.log({ event: 'tg.conversation.start_skipped', userTaskId, reason: 'terminal_state' });
        return false;
      }
      throw e;
    }
  }
}

class ControlPlaneErrorLike extends Error {}

/**
 * Journal fold of one task: a pure reduction of C02 events. The same code serves
 * the first open of a conversation and a reconnect after a restart — only the
 * starting cursor differs.
 */
class TaskProjection {
  constructor(userTaskId, cursor) {
    this.userTaskId = userTaskId;
    this.cursor = cursor;
    this.status = 'draft';
    this.stage = null;
    this.generation = 0;
    this.runIds = [];
    this.currentRunId = null;
    this.runStartedCount = 0;
    this.answersUsed = 0;
    this.terminal = null;
    this.result = null;
    this.artifactRefs = [];
    this.lateWritesRejected = 0;
    this.wakeInterrupted = false;
    this.signalKeys = [];
    this.runsUnknown = false;
    this.fencedCount = 0;
    this.openAwaiting = null;
  }

  apply(events) {
    for (const event of events) {
      this.cursor = Math.max(this.cursor, event.sequence);
      if (event.payload?.rejected === 'terminal_state') {
        this.lateWritesRejected += 1;
        continue;
      }
      const runId = event.runId ?? (typeof event.payload?.runId === 'string' ? event.payload.runId : null);
      switch (event.kind) {
        case 'run_started':
          this.runStartedCount += 1;
          if (runId) {
            this.runIds.push(runId);
            this.currentRunId = runId;
          }
          break;
        case 'fenced':
          this.fencedCount += 1;
          break;
        case 'awaiting_opened':
          this.openAwaiting = {
            id: String(event.payload?.awaitingInputId ?? ''),
            question: typeof event.payload?.question === 'string' ? event.payload.question : '',
            consumedByRun: null,
            answeredAt: null,
          };
          break;
        case 'awaiting_answered': {
          const id = event.payload?.awaitingInputId;
          if (this.openAwaiting && (id == null || id === this.openAwaiting.id)) {
            this.openAwaiting.consumedByRun = typeof event.payload?.consumedByRun === 'string' ? event.payload.consumedByRun : null;
            this.openAwaiting.answeredAt = event.occurredAt;
          }
          this.answersUsed += 1;
          break;
        }
        case 'signal_received': {
          const key = typeof event.payload?.idempotencyKey === 'string' ? event.payload.idempotencyKey : null;
          if (key && !this.signalKeys.includes(key)) this.signalKeys.push(key);
          break;
        }
        case 'signal_rejected':
          this.signalKeys.push(`rejected:${event.sequence}`);
          break;
        case 'result_ready':
          this.result = event.payload?.result ?? this.result;
          this.artifactRefs.push(...(Array.isArray(event.artifactRefs) ? event.artifactRefs : []));
          break;
        case 'task_status_changed':
        case 'task_cancelled': {
          const after = typeof event.payload?.statusAfter === 'string' ? event.payload.statusAfter : null;
          if (after && (after === 'done' || after === 'failed' || after === 'cancelled')) this.terminal = after;
          break;
        }
        case 'error':
          if (event.payload?.where === 'signal.wake') this.wakeInterrupted = true;
          break;
        default:
          break;
      }
      if (event.type === 'task_failed' && !this.terminal) this.terminal = 'failed';
      if (event.type === 'stopped' && !this.terminal) this.terminal = 'cancelled';
    }
  }

  applyStatus(status) {
    this.status = status.status;
    this.stage = status.stage;
    this.generation = status.generation;
    this.result = status.result ?? this.result;
    if (isTerminalTaskStatus(status.status) && !this.terminal) this.terminal = status.status;
    this.runsUnknown = hasUnknownOutcome(status);
  }

  view(entry, transport) {
    const artifacts = [...new Set(this.artifactRefs)].map(ref => ({
      ref,
      url: `/tg/conversations/${encodeURIComponent(entry.conversationId)}/artifacts/${encodeURIComponent(ref)}`,
    }));
    return {
      seq: entry.seq,
      kind: entry.kind,
      userTaskId: this.userTaskId,
      text: entry.text,
      createdAt: entry.createdAt,
      status: this.status,
      stage: this.stage,
      cursor: this.cursor,
      runIds: this.runIds,
      currentRunId: this.currentRunId,
      generation: this.generation,
      runStartedCount: this.runStartedCount,
      answersUsed: this.answersUsed,
      awaiting: this.openAwaiting
        ? {
            id: this.openAwaiting.id,
            question: this.openAwaiting.question,
            consumedByRun: this.openAwaiting.consumedByRun,
            answeredAt: this.openAwaiting.answeredAt,
          }
        : null,
      terminal: this.terminal,
      result: this.result,
      artifacts,
      unknownOutcome: this.runsUnknown,
      wakeDeliveryInterrupted: this.wakeInterrupted,
      lateWritesRejected: this.lateWritesRejected,
      fenced: this.fencedCount,
      signalKeys: this.signalKeys,
      transport,
    };
  }
}

/**
 * The open awaiting of a conversation = the last task turn that has
 * `awaiting_opened` but no `awaiting_answered` yet. An answer consumes it once.
 */
const awaitingTurnOf = (entries, turns) => {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    const entry = entries.find(item => item.seq === turn.seq);
    if (!entry || entry.kind !== 'new') continue;
    if (turn.awaiting && turn.awaiting.consumedByRun === null) {
      return {
        seq: turn.seq,
        userTaskId: turn.userTaskId,
        awaitingId: turn.awaiting.id,
        question: turn.awaiting.question,
        answerSeq: entries.length + 1,
      };
    }
  }
  return null;
};

export default {
  messageKey,
  ConversationSession,
  ConversationIndex,
  KvConversationStore,
  MemoryConversationStore,
  ConversationNotFoundError,
  NoAwaitingInputError,
};
