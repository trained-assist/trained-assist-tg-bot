// Controller that glues the slice together: profile mapping, update
// dedup, batch collection (PR-12), intake/answer against the new
// control plane, durable ACK + replay, result push + stale button
// retirement (U-10). The Worker itself is thin; this is the
// testable core (used by both the Hono handler and unit tests).
//
// Modes: 'direct' (default — P11 five-message scenario) and 'batch'
// (TG_SLICE_MODE=batch — accumulator with one launch button, AC-102).
import { ControlPlaneClient } from './control-plane-client.js';
import { profileForUpdate, extractMessage, extractCallbackQuery } from './profile.js';
import { BatchCollector, KvBatchStore, MemoryBatchStore, BATCH_STATUS, tooLargeMessage, isTooLarge, attachmentOf, launchButton } from './batch.js';
import { ConversationSession, ConversationIndex, KvConversationStore, MemoryConversationStore, ConversationNotFoundError, messageKey } from './conversation.js';
import { TgDeliveryOutbox } from './delivery.js';
import { logTg } from './log.js';
import { hasUnknownOutcome, isTerminalTaskStatus } from './contract.js';
import { MediaIntakeError, prepareTelegramArtifact } from './media-intake.js';

export const MODE = { direct: 'direct', batch: 'batch' };

export class TgSliceController {
  constructor(client, store, options = {}) {
    this.client = client;
    this.store = store;
    this.batchStore = options.batchStore ?? store;
    this.outbox = options.outbox;
    this.profile = options.profile;
    this.mode = options.mode ?? MODE.direct;
    this.maxTurns = options.maxTurns ?? 32;
    this.logSink = options.logSink;
    this.mediaIntake = options.mediaIntake;
  }

  log(fields) {
    logTg(fields, this.logSink);
  }

  /** Main entry point for one inbound Telegram update. */
  async handleUpdate(update) {
    const message = extractMessage(update);
    const callback = extractCallbackQuery(update);
    if (!message && !callback) return { effects: [], updateId: update?.update_id ?? null, reason: 'unsupported_update_kind' };
    const profile = profileForUpdate(this.profile, update);
    if (!profile) return { effects: [], updateId: update?.update_id ?? null, reason: 'chat_not_allowed' };

    const dedupKey = `u:${update.update_id}`;
    const deduped = await this.store.load(dedupKey);
    if (deduped?.status === 'processed') {
      this.log({ event: 'tg.ingest.duplicate_update', updateId: update.update_id, profileId: profile.profileId, reason: 'replay' });
      return { effects: [], updateId: update.update_id, duplicate: true, userTaskId: deduped.userTaskId };
    }

    const effects = callback
      ? await this.handleCallback(profile, callback, update)
      : await this.handleMessage(profile, message, update);

    await this.store.save({
      conversationId: dedupKey,
      status: 'processed',
      updateId: update.update_id,
      userTaskId: effects.find(e => e.userTaskId)?.userTaskId ?? null,
      processedAt: Date.now(),
    });
    this.log({
      event: 'tg.ingest.processed',
      updateId: update.update_id,
      profileId: profile.profileId,
      conversationId: profile.conversationId,
      effects: effects.map(e => e.type),
      reason: 'ok',
    });
    return { effects, updateId: update.update_id };
  }

  async handleCallback(profile, callback) {
    const data = callback.data;
    if (!data?.startsWith('tg-launch:')) return [];
    const conversationId = data.slice('tg-launch:'.length);
    if (conversationId !== profile.conversationId) return [];
    const batch = await this.batchStore.load(conversationId);
    if (!batch || batch.status !== BATCH_STATUS.collecting) return [];
    const unmaterialized = batch.items.find(item => item.mediaPending === true
      || (['voice', 'document', 'photo'].includes(item.type) && !item.artifactManifest)
      || (Array.isArray(item.artifactRefs) && item.artifactRefs.some(ref => typeof ref === 'string' && ref.startsWith('tg-file:'))));
    if (unmaterialized) {
      const requestId = messageKey(conversationId, batch.items.length + 1);
      await this.outbox?.enqueue({
        deliveryId: `media-unavailable:${requestId}`,
        taskAcceptedAt: Date.now(),
        conversationId,
        userTaskId: `tg-batch:${requestId}`,
        destination: { chatId: profile.destination.chatId, threadId: profile.destination.threadId },
        requestId,
        type: 'message',
        text: 'Вложение ещё не сохранено в буфере. Черновик сохранён; задачу не запускал. Проверь доступность медиа и нажми запуск повторно.',
      });
      return [{ type: 'refused', reason: 'unmaterialized_media', userTaskId: null, conversationId }];
    }
    batch.status = BATCH_STATUS.launched;
    batch.launchedAt = Date.now();
    await this.batchStore.save(batch);
    const inputItems = BatchCollector.toInputItems(batch);
    const requestId = messageKey(conversationId, batch.items.length + 1);
    const receipt = await this.client.intake({
      requestId,
      text: `batch:${batch.items.length} items`,
      conversationId,
      inputItems,
    });
    await this.client.start(receipt.userTaskId);
    const index = await this.store.load(conversationId) ?? new ConversationIndex(conversationId, profile.profileId);
    index.destination = profile.destination;
    index.requestingBot = profile.requestingBot;
    if (!index.turns.some(turn => turn.requestId === requestId)) {
      index.turns.push({
        seq: index.turns.length + 1,
        conversationId,
        kind: 'new',
        requestId,
        userTaskId: receipt.userTaskId,
        text: `batch:${batch.items.length} items`,
        inputItemCount: inputItems.length,
        createdAt: receipt.acceptedAt,
        providerAcceptedAt: receipt.providerAcceptedAt ?? null,
      });
    }
    await this.store.save(index);
    await this.outbox?.enqueue({
      deliveryId: `receipt:${requestId}`,
      taskAcceptedAt: receipt.providerAcceptedAt,
      conversationId,
      userTaskId: receipt.userTaskId,
      destination: { chatId: profile.destination.chatId, threadId: profile.destination.threadId },
      requestId,
      type: 'launch',
      text: `Задача принята (${batch.items.length} элементов), запущена`,
    });
    return [{ type: 'launch', userTaskId: receipt.userTaskId, conversationId }];
  }

  async handleMessage(profile, message, update) {
    if (this.mode === MODE.batch) return this.handleBatch(profile, message, update);
    return this.handleDirect(profile, message, update);
  }

  async handleDirect(profile, message, update) {
    const session = new ConversationSession(this.client, {
      conversationId: profile.conversationId,
      profileId: profile.profileId,
      store: this.store,
      logSink: this.logSink,
      maxTurns: this.maxTurns,
    });
    let view;
    try {
      view = await session.open();
    } catch (e) {
      if (e instanceof ConversationNotFoundError) {
        view = await session.create();
      } else throw e;
    }
    const awaiting = view.awaiting;
    session.index.destination = profile.destination;
    session.index.requestingBot = profile.requestingBot;
    await this.store.save(session.index);
    const text = typeof message.text === 'string' ? message.text : null;
    if (awaiting && text != null) {
      const answer = await session.answer(text);
      const effects = [{ type: 'answer', userTaskId: answer.userTaskId, seq: answer.seq, duplicate: answer.duplicate }];
      if (!answer.duplicate) {
        await this.outbox?.enqueue({
          deliveryId: `receipt:${answer.requestId}`,
          taskAcceptedAt: session.index.turns.find(turn => turn.userTaskId === answer.userTaskId && turn.kind === 'new')?.providerAcceptedAt,
          conversationId: profile.conversationId,
          userTaskId: answer.userTaskId,
          destination: profile.destination,
          requestId: answer.requestId,
          type: 'message',
          text: `Ответ принят — задача ${answer.userTaskId.slice(0, 12)}…`,
        });
      }
      return effects;
    }
    const requestId = `${profile.ingressRef}:u${update.update_id}`;
    const send = await session.sendMessage(text ?? '[no text]', null, null, requestId);
    const effects = [{ type: 'new', userTaskId: send.userTaskId, seq: send.seq, duplicate: send.duplicate }];
    if (!send.duplicate) {
      await this.outbox?.enqueue({
        deliveryId: `receipt:${send.requestId}`,
        taskAcceptedAt: session.index.turns.find(turn => turn.userTaskId === send.userTaskId && turn.kind === 'new')?.providerAcceptedAt,
        conversationId: profile.conversationId,
        userTaskId: send.userTaskId,
        destination: profile.destination,
        requestId: send.requestId,
        type: 'message',
        text: `Задача принята — запущена (${send.userTaskId.slice(0, 12)}…)`,
      });
    }
    return effects;
  }

  async handleBatch(profile, message, update = {}) {
    const effects = [];
    const collector = new BatchCollector(this.batchStore, { maxItems: this.profile?.maxBatchItems ?? 20 });
    const attachment = attachmentOf(message);
    if (attachment.type === 'text' && attachment.text) {
      const result = await collector.add(profile.conversationId, { type: 'text', text: attachment.text, sourceRef: profile.ingressRef, receivedAt: Date.now() });
      if (result.item) effects.push({ type: 'batch_item', item: result.item });
    } else if (attachment.type === 'voice' && attachment.fileId) {
      if (isTooLarge(attachment.fileSize)) {
        effects.push({ type: 'refused', text: tooLargeMessage(attachment.fileName, 5 * 1024 * 1024) });
        return effects;
      }
      const media = await this.prepareMedia(profile, message, attachment);
      const result = await collector.add(profile.conversationId, {
        type: 'voice', sourceRef: profile.ingressRef, durationSec: attachment.durationSec,
        fileName: attachment.fileName ?? 'voice.ogg', fileSize: attachment.fileSize, mimeType: attachment.mimeType,
        artifactManifest: media.manifest, mediaError: media.error, receivedAt: Date.now(),
      });
      if (result.item) effects.push({ type: 'batch_item', item: result.item });
      if (media.error) effects.push({ type: 'media_pending', reason: media.error });
    } else if ((attachment.type === 'document' || attachment.type === 'photo') && attachment.fileId) {
      if (isTooLarge(attachment.fileSize)) {
        effects.push({ type: 'refused', text: tooLargeMessage(attachment.fileName) });
        return effects;
      }
      const media = await this.prepareMedia(profile, message, attachment);
      const result = await collector.add(profile.conversationId, {
        type: attachment.type, sourceRef: profile.ingressRef, fileName: attachment.fileName,
        fileSize: attachment.fileSize, mimeType: attachment.mimeType,
        artifactManifest: media.manifest, mediaError: media.error, receivedAt: Date.now(),
      });
      if (result.item) effects.push({ type: 'batch_item', item: result.item });
      if (media.error) effects.push({ type: 'media_pending', reason: media.error });
    } else {
      effects.push({ type: 'unsupported', reason: attachment.type });
    }
    const currentBatch = await collector.load(profile.conversationId);
    if (currentBatch?.status === BATCH_STATUS.collecting && currentBatch.items.length > 0) {
      effects.push({ type: 'collector', text: `Накоплено: ${currentBatch.items.length} элементов`, markup: launchButton(currentBatch) });
    }
    return effects;
  }

  async prepareMedia(profile, message, attachment) {
    if (typeof this.mediaIntake !== 'function') return { manifest: null, error: 'media_buffer_unavailable' };
    try {
      return { manifest: await this.mediaIntake({ profile, message, attachment }), error: null };
    } catch (error) {
      this.log({ event: 'tg.media.buffer_failed', profileId: profile.profileId, reason: error instanceof MediaIntakeError ? error.message : 'storage_unavailable' });
      return { manifest: null, error: error instanceof MediaIntakeError ? error.message : 'storage_unavailable' };
    }
  }

  /** Background reconciliation: retry deliveries + push terminal results. */
  async reconcile() {
    const pushed = [];
    let drained = await this.outbox?.drain() ?? 0;
    const deadline = performance.now() + 10000;
    const bounded = async operation => {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error('discovery_deadline');
      let timer;
      try {
        return await Promise.race([operation(), new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('discovery_deadline')), remaining);
        })]);
      } finally { clearTimeout(timer); }
    };
    for (let step = 0; this.store.kv && step < 6 && performance.now() < deadline; step += 1) {
      try {
        const cursor = await bounded(() => this.outbox.discovery());
        if (cursor.conversationKey === null) {
          const page = await bounded(() => this.store.kv.list({ prefix: 'conv:tg-', cursor: cursor.pageCursor ?? undefined, limit: 1 }));
          const nextPageCursor = page.list_complete ? null : page.cursor;
          if (!page.list_complete && (!nextPageCursor || nextPageCursor === cursor.pageCursor)) throw new Error('discovery_pagination');
          await bounded(() => this.outbox.advanceDiscovery(cursor.revision, {
            pageCursor: page.keys.length ? cursor.pageCursor : nextPageCursor,
            conversationKey: page.keys[0]?.name ?? null, nextPageCursor: page.keys.length ? nextPageCursor : null, turnIndex: 0,
          }));
          if (!page.keys.length && page.list_complete) break;
          continue;
        }
        const raw = await bounded(() => this.store.kv.get(cursor.conversationKey));
        let index;
        try { index = JSON.parse(raw); } catch { index = null; }
        const valid = Array.isArray(index?.turns) && index.destination &&
          this.profile.allowedChats.includes(String(index.destination.chatId)) && index.requestingBot === this.profile.botUsername &&
          index.profileId === (this.profile.chatProfiles[String(index.destination.chatId)] ?? this.profile.profileId);
        const entry = valid ? index.turns[cursor.turnIndex] : null;
        const next = { pageCursor: cursor.nextPageCursor, conversationKey: null, nextPageCursor: null,
          turnIndex: entry && cursor.turnIndex + 1 < index.turns.length ? cursor.turnIndex + 1 : 0 };
        if (!await bounded(() => this.outbox.advanceDiscovery(cursor.revision, next)) || !entry || entry.kind !== 'new') continue;
        const status = await bounded(() => this.client.status(entry.userTaskId, { signal: AbortSignal.timeout(Math.max(1, Math.ceil(deadline - performance.now()))) }));
        if (status.id !== entry.userTaskId || !Number.isSafeInteger(status.generation) || status.generation < 1) continue;
        const terminal = isTerminalTaskStatus(status.status) ? status.status : null;
        if (!terminal && !hasUnknownOutcome(status)) continue;
        const deliveryId = `${terminal ? 'terminal' : 'unknown'}:${entry.userTaskId}:g${status.generation}`;
        if (await bounded(() => this.outbox.load(deliveryId))) continue;
        const answer = typeof status.result === 'string' ? status.result : status.result?.answer;
        const label = terminal === 'done' ? 'Готово. Текст результата отсутствует.' : terminal === 'failed' ? 'Ошибка исполнителя.' : terminal === 'cancelled' ? 'Отменено.' : 'Связь с исполнителем потеряна. Исход задачи неизвестен.';
        await bounded(() => this.outbox.enqueue({ deliveryId, taskAcceptedAt: entry.providerAcceptedAt,
          conversationId: index.conversationId, userTaskId: entry.userTaskId, destination: index.destination,
          requestId: deliveryId, type: 'message', text: terminal === 'done' && typeof answer === 'string' && answer.trim() ? answer : label }));
        pushed.push({ userTaskId: entry.userTaskId, terminal });
      } catch {
        this.log({ event: 'tg.reconcile.failed', reason: 'discovery_unavailable' });
        break;
      }
    }
    if (drained === 0 && performance.now() < deadline) drained = await this.outbox?.drain() ?? 0;
    return { drained, pushed };
  }
}

export default TgSliceController;
