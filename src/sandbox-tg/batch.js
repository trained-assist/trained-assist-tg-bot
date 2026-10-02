// Batch assembly of the Telegram slice (U-07 / PR-12) and media normalization
// (U-08 / PR-13).
//
// Batch: everything a user sends while the slice is collecting becomes ONE task
// with ONE launch button — ten messages and voice notes are ten input items of a
// single intake, never ten runs. The number of accepted items equals the number
// of input elements, and that equality is asserted by the tests.
//
// Media: the attachment type is decided by the Telegram message part (voice /
// document / photo), never by a guess from the extension. A file above the bot
// upload ceiling (20 MiB) is refused with a clear message instead of a silent
// drop; Cyrillic file names are preserved end to end.
import { TELEGRAM_FILE_SIZE_LIMIT_BYTES } from './contract.js';

export const BATCH_STATUS = {
  collecting: 'collecting',
  launched: 'launched',
};

export class BatchStoreError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BatchStoreError';
  }
}

/**
 * Durable store of batches. In the Worker this is the TG_SLICE KV namespace;
 * in tests it is memory. The interface is deliberately narrow: the batch is the
 * only durable ingress state of the slice besides the conversation index.
 */
export class KvBatchStore {
  constructor(kv) {
    this.kv = kv;
  }

  key(conversationId) {
    return `batch:${conversationId}`;
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

  async save(batch) {
    await this.kv.put(this.key(batch.conversationId), JSON.stringify(batch));
  }

  async clear(conversationId) {
    await this.kv.delete(this.key(conversationId));
  }
}

export class MemoryBatchStore {
  constructor() {
    this.data = new Map();
  }

  async load(conversationId) {
    const found = this.data.get(conversationId);
    return found ? structuredClone(found) : null;
  }

  async save(batch) {
    this.data.set(batch.conversationId, structuredClone(batch));
  }

  async clear(conversationId) {
    this.data.delete(conversationId);
  }
}

/**
 * One batch of one conversation. Items are appended in arrival order; the batch
 * is launched once (idempotent by conversation+batch id) and then never again.
 */
export class BatchCollector {
  constructor(store, options = {}) {
    this.store = store;
    this.maxItems = options.maxItems ?? 20;
    this.clock = options.clock ?? (() => Date.now());
  }

  async load(conversationId) {
    return this.store.load(conversationId);
  }

  /**
   * Add one inbound element. Returns the batch plus the item's sequence number.
   * A batch that was already launched collects nothing — a new element after the
   * launch belongs to the NEXT batch (the caller creates it).
   */
  async add(conversationId, item) {
    const existing = await this.store.load(conversationId);
    if (existing?.status === BATCH_STATUS.launched) return { batch: existing, item: null, reason: 'batch_already_launched' };
    const batch = existing ?? { conversationId, status: BATCH_STATUS.collecting, items: [], createdAt: this.clock() };
    if (batch.items.length >= this.maxItems) return { batch, item: null, reason: 'batch_full' };
    const normalized = normalizeItem(item, batch.items.length + 1);
    batch.items.push(normalized);
    await this.store.save(batch);
    return { batch, item: normalized, reason: 'added' };
  }

  /** Mark the batch launched. Idempotent: a second launch of the same batch is a no-op. */
  async markLaunched(conversationId) {
    const batch = await this.store.load(conversationId);
    if (!batch) return null;
    if (batch.status !== BATCH_STATUS.launched) {
      batch.status = BATCH_STATUS.launched;
      batch.launchedAt = this.clock();
      await this.store.save(batch);
    }
    return batch;
  }

  async clear(conversationId) {
    await this.store.clear(conversationId);
  }

  /** The batch as control-plane input items: one item per inbound element. */
  static toInputItems(batch) {
    return batch.items.map(item => ({
      text: item.summary,
      artifactRefs: item.artifactRefs ?? [],
    }));
  }
}

/**
 * Normalize one inbound element. `summary` is what the executor sees (text plus
 * a faithful description of the attachment); `artifactRefs` carries the file id
 * so the plane can fetch the bytes through the agreed source.
 */
export function normalizeItem(item, seq) {
  const base = {
    seq,
    type: item.type,
    receivedAt: item.receivedAt,
  };
  if (item.type === 'text') {
    return { ...base, text: item.text, summary: item.text, artifactRefs: [] };
  }
  if (item.type === 'voice') {
    return {
      ...base,
      text: null,
      fileId: item.fileId,
      durationSec: item.durationSec ?? null,
      mimeType: item.mimeType ?? 'audio/ogg',
      summary: item.tooLarge
        ? item.summary
        : `Голосовое сообщение (${item.durationSec ?? '?'} сек), file_id=${item.fileId}`,
      artifactRefs: item.tooLarge ? [] : [`tg-file:${item.fileId}`],
      tooLarge: Boolean(item.tooLarge),
    };
  }
  if (item.type === 'document' || item.type === 'photo') {
    return {
      ...base,
      text: null,
      fileId: item.fileId,
      fileName: item.fileName ?? null,
      fileSize: item.fileSize ?? null,
      mimeType: item.mimeType ?? null,
      summary: item.tooLarge ? item.summary : fileSummary(item),
      artifactRefs: item.tooLarge ? [] : [`tg-file:${item.fileId}`],
      tooLarge: Boolean(item.tooLarge),
    };
  }
  return { ...base, text: null, summary: item.summary ?? `[${item.type}]`, artifactRefs: [] };
}

function fileSummary(item) {
  const name = item.fileName ? `«${item.fileName}» ` : '';
  const size = item.fileSize != null ? `, ${formatBytes(item.fileSize)}` : '';
  return `Файл ${name}(${item.mimeType ?? 'файл'}${size}), file_id=${item.fileId}`;
}

/**
 * Decide what an inbound message carries. Pure function of the Telegram message
 * part — the type is never guessed from an extension.
 */
export function attachmentOf(message) {
  if (!message || typeof message !== 'object') return { type: 'empty' };
  if (typeof message.text === 'string' && message.text) return { type: 'text', text: message.text };
  if (message.voice) {
    return {
      type: 'voice',
      fileId: message.voice.file_id,
      durationSec: message.voice.duration ?? null,
      mimeType: message.voice.mime_type ?? 'audio/ogg',
      fileSize: message.voice.file_size ?? null,
    };
  }
  if (message.audio) {
    return {
      type: 'voice',
      fileId: message.audio.file_id,
      durationSec: message.audio.duration ?? null,
      mimeType: message.audio.mime_type ?? 'audio/mpeg',
      fileSize: message.audio.file_size ?? null,
    };
  }
  if (message.document) {
    return {
      type: 'document',
      fileId: message.document.file_id,
      fileName: message.document.file_name ?? null,
      fileSize: message.document.file_size ?? null,
      mimeType: message.document.mime_type ?? null,
    };
  }
  if (Array.isArray(message.photo) && message.photo.length) {
    const largest = message.photo[message.photo.length - 1];
    return {
      type: 'photo',
      fileId: largest.file_id,
      fileName: null,
      fileSize: largest.file_size ?? null,
      mimeType: 'image/jpeg',
    };
  }
  if (message.video) {
    return {
      type: 'document',
      fileId: message.video.file_id,
      fileName: message.video.file_name ?? null,
      fileSize: message.video.file_size ?? null,
      mimeType: message.video.mime_type ?? 'video/mp4',
    };
  }
  return { type: 'unsupported', hint: Object.keys(message).find(key => !['message_id', 'from', 'chat', 'date', 'message_thread_id'].includes(key)) ?? 'attachment' };
}

/** Human-readable refusal for a file above the bot ceiling (U-08 / PR-13). */
export function tooLargeMessage(fileName, limitBytes = TELEGRAM_FILE_SIZE_LIMIT_BYTES) {
  const name = fileName ? `«${fileName}» ` : '';
  return `Файл ${name}больше ${Math.round(limitBytes / 1024 / 1024)} МБ — бот пока не умеет такие забирать. Сожми файл или пришли ссылкой.`;
}

/** True when the attachment cannot be uploaded by a bot (20 MiB ceiling). */
export function isTooLarge(fileSize, limitBytes = TELEGRAM_FILE_SIZE_LIMIT_BYTES) {
  return typeof fileSize === 'number' && fileSize > limitBytes;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

/** The single launch button of a batch (one task, one button — AC-102). */
export function launchButton(batch) {
  return {
    inline_keyboard: [
      [{ text: `▶ Запустить (${batch.items.length})`, callback_data: `tg-launch:${batch.conversationId}` }],
    ],
  };
}

/** Dead button after the launch — a finished task keeps no active buttons (U-10). */
export function launchedButton(count) {
  return { inline_keyboard: [[{ text: `✓ Запущено (${count})`, callback_data: 'tg-none' }]] };
}

export default {
  BatchCollector,
  KvBatchStore,
  MemoryBatchStore,
  BATCH_STATUS,
  attachmentOf,
  isTooLarge,
  tooLargeMessage,
  launchButton,
  launchedButton,
  formatBytes,
};