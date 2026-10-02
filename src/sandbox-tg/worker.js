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
import { ConversationSession, KvConversationStore, MemoryConversationStore, ConversationNotFoundError, messageKey } from './conversation.js';
import { TgDeliveryOutbox, DELIVERY_STATUS } from './delivery.js';
import { logTg } from './log.js';

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
      id: dedupKey,
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
    const batch = await this.batchStore.load(conversationId);
    if (!batch || batch.status !== BATCH_STATUS.collecting) return [];
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
    await this.outbox?.enqueue({
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
    if (this.mode === MODE.batch) return this.handleBatch(profile, message);
    return this.handleDirect(profile, message);
  }

  async handleDirect(profile, message) {
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
    const text = typeof message.text === 'string' ? message.text : null;
    if (awaiting && text != null) {
      const answer = await session.answer(text);
      const effects = [{ type: 'answer', userTaskId: answer.userTaskId, seq: answer.seq, duplicate: answer.duplicate }];
      if (!answer.duplicate) {
        await this.outbox?.enqueue({
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
    const send = await session.sendMessage(text ?? '[no text]');
    const effects = [{ type: 'new', userTaskId: send.userTaskId, seq: send.seq, duplicate: send.duplicate }];
    if (!send.duplicate) {
      await this.outbox?.enqueue({
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

  async handleBatch(profile, message) {
    const effects = [];
    const collector = new BatchCollector(this.batchStore, { maxItems: this.profile?.maxBatchItems ?? 20 });
    const batch = (await collector.load(profile.conversationId)) ?? { conversationId: profile.conversationId, status: BATCH_STATUS.collecting, items: [], createdAt: Date.now() };
    const attachment = attachmentOf(message);
    if (attachment.type === 'text' && attachment.text) {
      const result = await collector.add(profile.conversationId, { type: 'text', text: attachment.text, receivedAt: Date.now() });
      if (result.item) effects.push({ type: 'batch_item', item: result.item });
    } else if (attachment.type === 'voice' && attachment.fileId) {
      if (isTooLarge(attachment.fileSize)) {
        effects.push({ type: 'refused', text: tooLargeMessage(attachment.fileName, 5 * 1024 * 1024) });
        return effects;
      }
      const result = await collector.add(profile.conversationId, { type: 'voice', fileId: attachment.fileId, durationSec: attachment.durationSec, receivedAt: Date.now() });
      if (result.item) effects.push({ type: 'batch_item', item: result.item });
    } else if ((attachment.type === 'document' || attachment.type === 'photo') && attachment.fileId) {
      if (isTooLarge(attachment.fileSize)) {
        effects.push({ type: 'refused', text: tooLargeMessage(attachment.fileName) });
        return effects;
      }
      const result = await collector.add(profile.conversationId, { type: attachment.type, fileId: attachment.fileId, fileName: attachment.fileName, fileSize: attachment.fileSize, mimeType: attachment.mimeType, receivedAt: Date.now() });
      if (result.item) effects.push({ type: 'batch_item', item: result.item });
    } else {
      effects.push({ type: 'unsupported', reason: attachment.type });
    }
    if (batch.status === BATCH_STATUS.collecting && batch.items.length > 0) {
      effects.push({ type: 'collector', text: `Накоплено: ${batch.items.length} элементов`, markup: launchButton(batch) });
    }
    return effects;
  }

  /** Background reconciliation: retry deliveries + push terminal results. */
  async reconcile() {
    const drained = await this.outbox?.drain() ?? 0;
    const pushed = [];
    const iter = this.store.kv?.list?.({ prefix: 'conv:' });
    if (iter) {
      for await (const item of iter) {
        try {
          const index = JSON.parse(item.value);
          const session = new ConversationSession(this.client, {
            conversationId: index.conversationId,
            profileId: index.profileId,
            store: this.store,
            logSink: this.logSink,
            maxTurns: this.maxTurns,
          });
          const view = await session.open();
          for (const turn of view.turns) {
            if (!turn.unknownOutcome && !turn.terminal) continue;
            const delivery = await this.outbox?.load(turn.userTaskId);
            if (delivery?.status === DELIVERY_STATUS.sent) continue;
            const label = turn.terminal === 'done' ? 'Готово.' : turn.terminal === 'failed' ? 'Ошибка исполнителя.' : 'Отменено.';
            await this.outbox?.enqueue({
              conversationId: index.conversationId,
              userTaskId: turn.userTaskId,
              destination: { chatId: profile?.destination?.chatId ?? index.profileId, threadId: null },
              requestId: `terminal:${turn.userTaskId}`,
              type: 'message',
              text: label,
            });
            pushed.push({ userTaskId: turn.userTaskId, terminal: turn.terminal });
          }
        } catch {
          // ignore malformed entries
        }
      }
    }
    return { drained, pushed };
  }
}

export default TgSliceController;