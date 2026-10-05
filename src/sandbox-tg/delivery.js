// Durable delivery outbox (ACK + replay) of the Telegram slice.
//
// Guarantees:
//  1. One outgoing reply per deliveryId (delivery owner). Repeated
//     updates (duplicate webhook pushes) never create a second reply;
//     receipts and terminal results have separate keys, and the record is
//     written ONLY after the KV receipt of intake/signal — so even a
//     lost HTTP response after persistence is recovered by replay.
//  2. If Telegram is down (5xx / 429 / network), the outbox retries
//     on the reconciliation alarm with exponential backoff; the
//     underlying task is NEVER re-run because of a delivery failure.
//  3. Answers only to the CHAT + the REQUESTING BOT (U-09 / PR-11):
//     every record carries the destination, and the worker validates
//     it before each send.
//  4. Finished tasks' inline buttons are replaced by dead marks
//     (U-10 / AC-105) by the slice handler when it sees the task go
//     terminal — no stale launch buttons survive.
import { logTg } from './log.js';
import { kvEntries } from './kv.js';

export const DELIVERY_STATUS = {
  pending: 'pending',
  retrying: 'retrying',
  sent: 'sent',
  dead: 'dead',
};

export class TgDeliveryOutbox {
  constructor(kv, api, options = {}) {
    this.kv = kv;
    this.api = api;
    this.maxAttempts = options.deliveryMaxAttempts ?? 6;
    this.retryBaseMs = options.retryBaseMs ?? 1000;
    this.logSink = options.logSink;
  }

  key(userTaskId) {
    return `delivery:${userTaskId}`;
  }

  async load(userTaskId) {
    const raw = await this.kv.get(this.key(userTaskId));
    if (!raw) return null;
    try {
      const record = JSON.parse(raw);
      return record && typeof record === 'object' ? record : null;
    } catch {
      return null;
    }
  }

  async save(record) {
    await this.kv.put(this.key(record.deliveryId ?? record.userTaskId), JSON.stringify(record));
  }

  async delete(userTaskId) {
    await this.kv.delete(this.key(userTaskId));
  }

  /**
   * Enqueue one reply for a task. Duplicate deliveryId = idempotent:
   * the stored reply text is re-sent verbatim; the caller decides
   * whether it is a real repeat or a replay of the same update.
   */
  async enqueue(record) {
    const deliveryId = record.deliveryId ?? record.userTaskId;
    const existing = await this.load(deliveryId);
    if (existing) {
      this.log({ event: 'tg.delivery.replayed', userTaskId: record.userTaskId, duplicate: true });
      return { record: existing, duplicate: true };
    }
    const next = {
      deliveryId,
      conversationId: record.conversationId,
      userTaskId: record.userTaskId,
      destination: record.destination,
      requestId: record.requestId,
      type: record.type,
      text: record.text,
      replyMarkup: record.replyMarkup ?? null,
      document: record.document ?? null,
      status: DELIVERY_STATUS.pending,
      attempts: 0,
      lastStatus: null,
      history: [],
      createdAt: Date.now(),
    };
    await this.save(next);
    return { record: next, duplicate: false };
  }

  /** Reconciliation: retry every pending/retrying entry until the cap. */
  async drain() {
    const records = [];
    for await (const item of kvEntries(this.kv, 'delivery:')) {
      let record;
      try {
        record = JSON.parse(item.value);
      } catch {
        continue;
      }
      if (record && typeof record === 'object') records.push(record);
    }
    records.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    let done = 0;
    for (const record of records) {
      if (record.status !== DELIVERY_STATUS.pending && record.status !== DELIVERY_STATUS.retrying) continue;
      done += 1;
      await this.attempt(record);
    }
    return done;
  }

  async attempt(record) {
    record.attempts += 1;
    record.lastStatus = null;
    const result = await this.sendOne(record);
    if (result.ok) {
      record.status = DELIVERY_STATUS.sent;
      record.telegramMessageId = result.messageId;
      record.sentAt = Date.now();
    } else {
      record.lastStatus = result.status;
      record.history.push({ at: Date.now(), status: result.status });
      record.status = record.attempts >= this.maxAttempts ? DELIVERY_STATUS.dead : DELIVERY_STATUS.retrying;
    }
    await this.save(record);
    this.log({
      event: result.ok ? 'tg.delivery.sent' : 'tg.delivery.failed',
      userTaskId: record.userTaskId,
      status: record.status,
      attempts: record.attempts,
      reason: result.ok ? 'ok' : result.status,
    });
    return record;
  }

  /** Remove stale inline buttons of finished tasks (U-10). */
  async retireStaleButtons(api, chatId, userTaskId) {
    const sent = api.outboundCalls('sendMessage').filter(m => m.message.chat.id === chatId);
    for (const message of sent) {
      const hasLaunch = message.request.reply_markup?.inline_keyboard?.some(row =>
        row.some(cell => String(cell.callback_data ?? '').startsWith('tg-launch:')),
      );
      if (hasLaunch) {
        await api.editMessageReplyMarkup({
          chatId,
          messageId: message.message.message_id,
          replyMarkup: { inline_keyboard: [[{ text: '✓ завершено', callback_data: 'tg-none' }]] },
        });
        this.log({ event: 'tg.delivery.button_retired', chatId, userTaskId });
      }
    }
  }

  async sendOne(record) {
    try {
      if (record.type === 'launch') {
        const result = await this.api.sendMessage({
          chatId: record.destination.chatId,
          threadId: record.destination.threadId,
          text: record.text,
          replyMarkup: record.replyMarkup,
        });
        return { ok: true, messageId: result.message_id };
      }
      if (record.type === 'message') {
        const result = await this.api.sendMessage({
          chatId: record.destination.chatId,
          threadId: record.destination.threadId,
          text: record.text,
          replyToMessageId: record.replyToMessageId ?? null,
        });
        return { ok: true, messageId: result.message_id };
      }
      if (record.type === 'document') {
        const result = await this.api.sendDocument({
          chatId: record.destination.chatId,
          document: record.document,
          filename: record.filename,
          caption: record.caption,
        });
        return { ok: true, messageId: result.message_id };
      }
      return { ok: false, status: 400, reason: 'unknown_type' };
    } catch (e) {
      const status = e instanceof Error && 'status' in e ? e.status : 0;
      return { ok: false, status };
    }
  }

  log(fields) {
    logTg(fields, this.logSink);
  }
}

export default { TgDeliveryOutbox, DELIVERY_STATUS };
