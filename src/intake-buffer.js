import { mediaEnabled, mediaOf, mediaId, enqueueMedia, ackText } from './media-jobs.js';
import { getSession } from './lib/kv.js';
import { checkCompleteness } from './lib/agent-client.js';
import { applySessionNamespace } from './lib/session-namespace.js';
// Durable Object: per-chat intake buffer.
//
// Automatic launch requires three quiet minutes AND an actionable request.
// Explicit launch commands/buttons bypass the timer. New input invalidates any
// in-flight gate verdict; reservation compares the exact checked buffer under lock.
// Files alone are context, never an instruction. Gate failures keep the collector.
//
// Two states, both owned here so the rule is one place for every user:
//   • idle     — messages pile into `buf`; a single collector message shows the
//                launch button and its live count. A debounce alarm is armed.
//   • busy     — a run is in flight for this chat: new messages accumulate
//                silently and are surfaced with a fresh launch button once the run
//                finishes (never auto-dispatched).
//
// One instance per chat_id (idFromName(chatId)). DO fetch/alarm handlers can
// interleave at external awaits. Short state mutations use an explicit lock;
// Telegram and transcription I/O must never hold that lock.
// The alarm also recovers reserved media jobs; for runs it is a safety net: if a run's isolate dies before clearing `busy`,
// BUSY_MAX_MS releases the hold so the buffer can't be trapped forever.

import { sendMessage, sendDocument, sendMessageWithKeyboard, editMessage, editMessageReplyMarkup, deleteMessage } from './lib/telegram.js';
import { coalesceBuffer, coalesceItem } from './intake-routing.js';

// Reply-anchor a new message to the one that triggered it — the only way a fresh
// bubble reliably appears right after the user's own message once the chat has
// scrolled (an edit to an older bubble is invisible off-screen). Best-effort:
// if the source message was since deleted, still deliver un-anchored.
const anchor = messageId => (messageId ? { reply_to_message_id: messageId, allow_sending_without_reply: true } : {});

const BUSY_MAX_MS = 45 * 60_000; // safety: release a run marked busy whose isolate
                                 // died mid-flight. Must exceed the longest
                                 // legitimate session (~40 min agent cap).
const DEBOUNCE_MS = 3 * 60_000; // quiet period for ALL automatic launches

const LAUNCH_BTN = [[{ text: '▶️ Запустить проработку', callback_data: 'intake_run' }]];

const collectorText = n =>
  `📥 Принял ✅ Накапливаю (${n}). Если задача понятна, запущу после 3 минут без новых сообщений. Можешь дополнить или жми «▶️ Запустить проработку», когда закончишь.`;

// Shown while a run is in flight: the buffer holds new messages (never auto-runs),
// but the user MUST still see they were received. Silence here was the «спросил
// "работает" — молчит» bug — a busy hold produced no Telegram output at all.
const heldText = n =>
  `⏳ Иду по текущей задаче. Принял ещё (${n}) — покажу кнопку «▶️ Запустить», как закончу.`;

// Gate said "insufficient": must NEVER auto-dispatch, and the user must be told
// plainly that nothing was launched — a silent non-launch reads as a broken bot.
const insufficientText =
  '❔ Не запускаю автоматически — похоже, не хватает контекста, чтобы понять задачу. Дополни или жми «▶️ Запустить проработку», если и так достаточно.';

export class IntakeBuffer {
  constructor(state, env) {
    this.state = state;
    // Apply the same SESSION_NAMESPACE wrapping as dispatchInner — DO receives env
    // directly from the Workers runtime so it can't piggyback on the fetch-handler
    // wrapper. Without this, session reads inside the DO ignore the namespace and
    // can find sessions from a different bot (cross-bot auto-login bug).
    this.env = applySessionNamespace(env);
    this.mutation = Promise.resolve();
  }

  async _exclusive(fn) {
    const previous = this.mutation;
    let release;
    this.mutation = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await fn(); } finally { release(); }
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/debug' && request.method === 'GET') {
      const [buf, retryBatch, retryBatchAttempts, busy, busySince, launching, debounceExpiresAt, gateLevel] =
        await Promise.all([
          this.state.storage.get('buf'), this.state.storage.get('retryBatch'),
          this.state.storage.get('retryBatchAttempts'), this.state.storage.get('busy'),
          this.state.storage.get('busySince'), this.state.storage.get('launching'),
          this.state.storage.get('debounceExpiresAt'), this.state.storage.get('gateLevel'),
        ]);
      const summarize = items => (items || []).map(i => ({
        messageId: i.msg?.message_id, hasText: !!i.text, mediaPending: !!i.mediaPending,
        mediaJob: i.msg?.mediaJob, fileRefStorage: i.msg?.fileRef?.storage,
        preparingAt: i.preparingAt, enqueueFailures: i.enqueueFailures || 0,
      }));
      const cursor = url.searchParams.get('cursor');
      const failed = await this.state.storage.list({ prefix: 'failed:', limit: 100,
        ...(cursor && /^failed:[a-f0-9-]{36}$/.test(cursor) ? { startAfter: cursor } : {}) });
      return json({
        failedBatchesNextCursor: failed.size === 100 ? [...failed.keys()].at(-1) : null,
        failedBatches: [...failed.values()].map(({ id, items, failedAt, messageId, status }) =>
          ({ id, failedAt, messageId, status, items: summarize(items) })),
        buf: summarize(buf), retryBatch: summarize(retryBatch), retryBatchAttempts: retryBatchAttempts || 0,
        busy: !!busy, busySince: busySince || null, launching: summarize(launching),
        debounceExpiresAt: debounceExpiresAt || null, gateLevel: gateLevel || null,
      });
    }

    if (url.pathname === '/restore' && request.method === 'POST') {
      const { id } = await request.json();
      if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) return new Response('invalid id', { status: 400 });
      return this._exclusive(async () => this.state.storage.transaction(async tx => {
        if (await tx.get('busy') || (await tx.get('retryBatch'))?.length) return new Response('busy', { status: 409 });
        const batch = await tx.get(`failed:${id}`);
        if (!batch) return new Response('not found', { status: 404 });
        await tx.put('retryBatch', batch.items);
        await tx.delete('retryBatchAttempts');
        await tx.delete(`failed:${id}`);
        // No task, alarm or Telegram notification is triggered by restoration.
        return json({ restored: true, count: batch.items.length });
      }));
    }

    if (url.pathname === '/media-result' && request.method === 'POST') {
      return this._mediaResult(await request.json());
    }

    if (url.pathname === '/ingest' && request.method === 'POST') {
      let { msg } = await request.json();
      if (mediaEnabled(this.env) && mediaOf(msg)) {
        const session = await getSession(this.env.SESSIONS, msg.chat.id);
        if (session) return this._ingestMedia(msg, session);
      }
      // Reserve BEFORE STT/network awaits: launch must not silently omit a slow voice.
      const accepted = await this._exclusive(async () => {
        const items = (await this.state.storage.get('buf')) || [];
        const seen = (await this.state.storage.get('received')) || [];
        if (seen.includes(msg.message_id) || items.some(i => i.msg.message_id === msg.message_id)) return false;
        items.push({ text: msg.text, msg, preparingAt: Date.now() });
        await this.state.storage.put('buf', items);
        return true;
      });
      if (!accepted) return json({ duplicate: true });
      let result = { msg };
      try {
        const { preflight } = await import('./intake-preflight.js');
        result = await preflight(msg, this.env, async prepared => {
          msg = prepared;
          result = { msg: prepared };
          await this._exclusive(async () => {
            const items = (await this.state.storage.get('buf')) || [];
            const index = items.findIndex(i => i.msg.message_id === prepared.message_id);
            if (index >= 0) items[index] = { ...items[index], msg: prepared };
            await this.state.storage.put('buf', items);
          });
        });
      } catch (error) {
        await sendMessage(this.env.BOT_TOKEN, msg.chat.id,
          '⚠️ Сообщение сохранено для повтора, но подготовка файла или расшифровки ещё не завершена. Повторю при запуске проработки.');
        console.warn('[intake prepare]', error.message);
      }
      // `armSeq` is a monotonic claim token: two attachments whose slow preflight()
      // overlaps (a realistic "two voice notes within a second" burst) used to each
      // read `buf`/`busy` OUTSIDE any lock here and independently call
      // _armAutoDispatch — duplicate collector bubbles, the earlier one reporting a
      // stale count (regression test: "two ingests whose preflight overlaps...").
      // Committing the write AND claiming the next token happen atomically, so only
      // the call that turns out to be the LAST one committed (checked just below,
      // itself lock-protected but I/O-free) actually sends — see the file-level
      // comment on why the send itself still happens outside the lock.
      const claim = await this._exclusive(async () => {
        const items = (await this.state.storage.get('buf')) || [];
        const index = items.findIndex(i => i.msg.message_id === msg.message_id);
        if (index >= 0) {
          if (result.handled) items.splice(index, 1);
          else items[index] = { text: result.msg.text, msg: result.msg, intentText: msg.text || msg.caption || '' };
        }
        await this.state.storage.put('buf', items);
        const seen = (await this.state.storage.get('received')) || [];
        await this.state.storage.put('received', [...seen, msg.message_id].slice(-1000));
        const seq = ((await this.state.storage.get('armSeq')) || 0) + 1;
        await this.state.storage.put('armSeq', seq);
        return { items, busy: await this.state.storage.get('busy'), seq };
      });
      if (result.handled) return json({ handled: true });
      if (!claim.items.length) return json({ buffered: 0 });
      if (claim.busy) {
        await this._showHeldNotice(msg.chat.id, claim.items.length, msg.message_id);
        return json({ buffered: claim.items.length });
      }
      const stillFreshest = await this._exclusive(async () => (await this.state.storage.get('armSeq')) === claim.seq);
      if (stillFreshest) await this._armAutoDispatch(msg.chat.id, claim.items, msg.message_id);
      return json({ buffered: claim.items.length });
    }

    if (url.pathname === '/append' && request.method === 'POST') {
      const { text, msg, flush } = await request.json();
      const buf = await this._exclusive(async () => {
        const items = (await this.state.storage.get('buf')) || [];
        // Telegram can retry delivery of the same update.
        if (!msg.message_id || !items.some(item => item.msg.message_id === msg.message_id)) {
          items.push({ text, msg });
          await this.state.storage.put('buf', items);
        }
        return items;
      });

      if ((await this.state.storage.get('busy')) === true) {
        // A run is in flight — hold new messages (never auto-run), but ACK them so
        // the user isn't met with silence. A fresh launch button is offered once
        // the run finishes; here we only confirm receipt.
        await this._showHeldNotice(msg.chat?.id, buf.length, msg.message_id);
        return json({ buffered: buf.length, held: true });
      }
      if (flush) {
        // Force word (запускай/го) — launch immediately, coalescing everything.
        return this.fetch(new Request('https://intake/flush', { method: 'POST' }));
      }
      // Idle: arm the debounce timer and show the launch button with the live count.
      await this._armAutoDispatch(msg.chat?.id, buf, msg.message_id, { allowShort: false });
      return json({ buffered: buf.length });
    }

    if (url.pathname === '/flush' && request.method === 'POST') {
      // Button tap. If a run is somehow already going, ignore (don't double-fire).
      if ((await this.state.storage.get('busy')) === true) return json({ busy: true });
      const buf = (await this.state.storage.get('retryBatch')) || (await this.state.storage.get('buf')) || [];
      if (!buf.length) return json({ empty: true });
      const pending = buf.some(i => i.mediaPending || (i.preparingAt && Date.now() - i.preparingAt < 120000));
      if (pending) {
        await sendMessage(this.env.BOT_TOKEN, buf[0].msg.chat.id, '⏳ Ещё расшифровываю полученные сообщения. Нажми запуск после расшифровки — пачка сохранена.');
        return json({ preparing: true });
      }
      await this._dispatch();
      return json({ flushed: true });
    }

    return new Response('not found', { status: 404 });
  }

  async _ingestMedia(msg, session) {
    const id = await mediaId(msg);
    const accepted = await this._exclusive(async () => {
      const seen = (await this.state.storage.get('received')) || [];
      const items = (await this.state.storage.get('buf')) || [];
      if (seen.includes(msg.message_id) || items.some(i => i.msg.message_id === msg.message_id)) return false;
      // Reservation and watchdog survive a crash before enqueue's network call.
      await this.state.storage.transaction(async tx => {
        items.push({ text: msg.text, msg: { ...msg, mediaJob: id }, mediaPending: true, mediaOwner: session.username });
        await tx.put('buf', items);
        await tx.put('received', [...seen, msg.message_id].slice(-1000));
        await tx.setAlarm(Date.now() + 60000);
      });
      // Media buffered: cancel any pending debounce so the auto-dispatch timer
      // doesn't fire while we're still waiting for the transcript.
      await this.state.storage.delete('debounceExpiresAt');
      await this.state.storage.delete('gateLevel');
      return true;
    });
    if (!accepted) return json({ duplicate: true });
    await enqueueMedia(msg, this.env, session).catch(() => {}); // watchdog retries
    const remaining = (await this.state.storage.get('buf')) || [];
    if (await this.state.storage.get('busy')) await this._showHeldNotice(msg.chat.id, remaining.length, msg.message_id);
    else {
      // Show a receipt without the launch button — the button will appear once
      // transcription is done (in _mediaResult). Showing the button first and
      // transcript second was confusing users: they'd tap launch, get "still
      // transcribing", and not know to tap again after the transcript arrived.
      await sendMessage(this.env.BOT_TOKEN, msg.chat.id,
        ackText(msg), anchor(msg.message_id)).catch(() => {});
    }
    return json({ queued: true, id });
  }

  async _recoverMedia() {
    const pending = ((await this.state.storage.get('buf')) || []).filter(i => i.mediaPending);
    if (!pending.length) return;
    await this.state.storage.setAlarm(Date.now() + 60000);
    for (const item of pending) {
      try {
        await enqueueMedia(item.msg, this.env, { username: item.mediaOwner }, true);
      } catch {
        let failed = false;
        await this._exclusive(async () => {
          const items = (await this.state.storage.get('buf')) || [];
          const current = items.find(i => i.msg.mediaJob === item.msg.mediaJob && i.mediaPending);
          if (!current) return;
          current.enqueueFailures = (current.enqueueFailures || 0) + 1;
          failed = current.enqueueFailures >= 3;
          await this.state.storage.put('buf', items);
        });
        if (failed) await this._mediaResult({ id: item.msg.mediaJob, messageId: item.msg.message_id,
          username: item.mediaOwner, error: 'Очередь обработки временно недоступна' });
      }
    }
  }

  async _mediaResult(result) {
    let notify = null;
    const response = await this._exclusive(async () => {
      const items = (await this.state.storage.get('buf')) || [];
      const index = items.findIndex(i => i.msg.mediaJob === result.id && i.msg.message_id === result.messageId);
      // Already committed: delivery retry must not overwrite/recreate an item.
      if (index < 0) {
        const delivered = await this.state.storage.get(`media-delivered:${result.id}`);
        return delivered ? json({ duplicate: true }) : new Response('Reservation missing', { status: 409 });
      }
      const item = items[index];
      if (item.mediaOwner !== result.username) return new Response('Owner mismatch', { status: 403 });
      if (!item.mediaPending) return json({ duplicate: true });
      if (!result.error && (!result.fileRef || result.fileRef.id !== result.id || result.fileRef.storage !== 'r2')) {
        return new Response('Invalid result', { status: 400 });
      }
      await this.state.storage.transaction(async tx => {
        if (result.error) {
          // Keep failed media outside the launchable batch so new text can proceed.
          // Original Telegram metadata and any completed R2 stages stay durable.
          await tx.put(`media-failed:${result.id}`, { ...item, error: result.error });
          items.splice(index, 1);
        } else {
          items[index] = { ...item, mediaPending: false, msg: { ...item.msg,
            fileRef: result.fileRef, transcript: result.transcript, transcriptRef: result.transcriptRef } };
        }
        await tx.put('buf', items);
        await tx.put(`media-delivered:${result.id}`, true);
        if (!items.some(i => i.mediaPending) && !(await tx.get('busy'))) await tx.deleteAlarm();
      });
      notify = { chatId: item.msg.chat.id, messageId: item.msg.message_id };
      return json({ accepted: true });
    });
    if (notify) {
      const text = result.error
        ? `⚠️ ${result.error}. Ссылка на вложение сохранена для восстановления; в следующую задачу оно не войдёт. Можно продолжать текстом; для повторной обработки отправь вложение ещё раз.`
        : result.transcript ? `🎤 ${result.transcript}` : '✅ Вложение сохранено. Можно запускать проработку.';
      if (!result.error && result.transcript?.length >= 800) {
        await sendDocument(this.env.BOT_TOKEN, notify.chatId, `transcript-${notify.messageId}.txt`, result.transcript, '🎤 Расшифровка голосового').catch(() => {});
      } else {
        await sendMessage(this.env.BOT_TOKEN, notify.chatId, text, { ...anchor(notify.messageId), parse_mode: undefined }).catch(() => {});
      }
      // After the transcript arrives, arm auto-dispatch the same way a plain text
      // message would (fresh launch button + gate). Before this fix a buffer whose
      // newest item was media never got auto-dispatch armed at all — _ingestMedia
      // deletes any pending debounce and nothing here re-armed it, so a batch that
      // ended in a photo/voice message could ONLY ever be launched by hand, even
      // once the transcript made its content fully readable (the "звонил чётко,
      // ничего не запустилось" bug, 2026-09-22).
      if (!result.error) {
        const remaining = (await this.state.storage.get('buf')) || [];
        const busy = await this.state.storage.get('busy');
        if (!busy && remaining.length && !remaining.some(i => i.mediaPending)) {
          await this._armAutoDispatch(notify.chatId, remaining, notify.messageId);
        }
      }
    }
    return response;
  }

  // Idle + non-busy: (re)arm the debounce timer and show the launch button with
  // the live count. One place for every caller (plain text, legacy /append, and
  // a media item whose transcript just resolved) so the auto-dispatch gate is
  // never silently skipped for one of them.
  async _armAutoDispatch(chatId, remaining, replyToMessageId) {
    await this.state.storage.delete('gateLevel');
    await this.state.storage.delete('shortDebounce');
    await this.state.storage.put('autoPolicy', 'quiet-3m-v1');
    const debounceMs = DEBOUNCE_MS;
    const expiresAt = Date.now() + debounceMs;
    await this.state.storage.put('debounceExpiresAt', expiresAt);
    await this.state.storage.setAlarm(expiresAt);
    await this._showCollector(chatId, remaining.length, replyToMessageId);
  }

  // ACK every accumulated message with a FRESH bubble anchored to it — never an
  // edit of an older one. An edit is invisible once the chat has scrolled past
  // it, which is exactly what read as "did my message even arrive?" (the owner
  // rejected the old edit-in-place design for this reason, 2026-09-15). The
  // previous collector's button is stripped so only the newest is tappable —
  // all buttons flush the same chat-keyed buffer, so a stale one is cosmetic
  // clutter at worst, but one live button reads cleaner.
  async _showCollector(chatId, count, replyToMessageId) {
    if (!chatId) return;
    const prevId = await this.state.storage.get('collectorMsgId');
    if (prevId) {
      await editMessageReplyMarkup(this.env.BOT_TOKEN, chatId, prevId, [])
        .catch(err => console.error(`[intake ${chatId}] strip prior collector button failed:`, err?.message));
    }
    const sent = await sendMessageWithKeyboard(
      this.env.BOT_TOKEN, chatId, collectorText(count), LAUNCH_BTN, anchor(replyToMessageId),
    ).catch(err => { console.error(`[intake ${chatId}] send collector failed:`, err?.message); return null; });
    const newId = sent?.result?.message_id;
    if (newId) {
      await this.state.storage.put('collectorMsgId', newId);
      return;
    }
    console.error(`[intake ${chatId}] collector-with-keyboard not delivered, retrying without keyboard:`, sent?.description || sent);
    // The buffer already has the message (buf.push happened before this call) — losing
    // the ack here reads as "the bot ate my message" even though nothing was lost. Try
    // once more without the inline keyboard in case the markup itself is what Telegram
    // rejected; the force word (see FORCE_RUN_RE) still launches without a button.
    const plain = await sendMessage(this.env.BOT_TOKEN, chatId, collectorText(count), anchor(replyToMessageId))
      .catch(err => { console.error(`[intake ${chatId}] plain-text collector retry failed:`, err?.message); return null; });
    const plainId = plain?.result?.message_id;
    if (plainId) await this.state.storage.put('collectorMsgId', plainId);
    else console.error(`[intake ${chatId}] collector message not delivered at all — buf accepted silently, user sees no ack:`, plain?.description || plain);
  }

  // Confirm receipt of a message held during an in-flight run. Same rule as the
  // collector: a fresh bubble per message, anchored to it, not an edit of a
  // rolling notice — the rolling edit was invisible once scrolled past.
  async _showHeldNotice(chatId, count, replyToMessageId) {
    if (!chatId) return;
    const sent = await sendMessage(this.env.BOT_TOKEN, chatId, heldText(count), anchor(replyToMessageId))
      .catch(err => { console.error(`[intake ${chatId}] send held-notice failed:`, err?.message); return null; });
    if (!sent?.result?.message_id) {
      console.error(`[intake ${chatId}] held-notice not delivered — buf accepted silently, user sees no ack:`, sent?.description || sent);
    }
  }

  // Coalesce the buffer into one message and run it. Marks the chat busy so
  // anything sent during the run is held (surfaced with a new button afterwards).
  async _dispatch(expectedBuffer) {
    const buf = await this._exclusive(async () => {
      if (await this.state.storage.get('busy')) return [];
      if (expectedBuffer !== undefined && JSON.stringify((await this.state.storage.get('buf')) || []) !== expectedBuffer) return [];
      // Cancel any pending debounce alarm — dispatch is happening now (manually or
      // via the timer itself). Without this the alarm could fire a second dispatch.
      await this.state.storage.delete('debounceExpiresAt');
      await this.state.storage.delete('gateLevel');
      const retryBatch = await this.state.storage.get('retryBatch');
      const items = retryBatch || (await this.state.storage.get('buf')) || [];
      if (!items.length) return [];
      if (items.some(i => i.mediaPending || (i.preparingAt && Date.now() - i.preparingAt < 120000))) return [];
      items.sort((a, b) => (a.msg.message_id || 0) - (b.msg.message_id || 0));
      await this.state.storage.put('busy', true);
      await this.state.storage.put('busySince', Date.now());
      await this.state.storage.put('launching', items);
      await this.state.storage.setAlarm(Date.now() + BUSY_MAX_MS);
      if (!retryBatch) await this.state.storage.delete('buf');
      await this.state.storage.delete('retryBatch');
      return items;
    });
    if (!buf.length) return;

    const base = buf[buf.length - 1].msg;
    const chatId = base.chat?.id;
    const coalescedText = coalesceBuffer(buf);
    const continuation = buf.find(item => item.msg.intakeRoute)?.msg;
    const msg = { ...base, text: coalescedText, intakeItems: buf,
      intakeRoute: continuation?.intakeRoute };

    // Do NOT stream the agent response into the old collector — it may have been
    // sent before the voice transcript was posted (the collector's message_id is
    // lower, so it appears above the transcript in the chat). Send a fresh
    // placeholder whose message_id is guaranteed to be higher than any
    // already-posted transcript.
    const collectorMsgId = await this.state.storage.get('collectorMsgId');
    await this.state.storage.delete('collectorMsgId');
    const lastMsgId = base.message_id || null;
    const placeholderRes = await sendMessage(
      this.env.BOT_TOKEN, chatId, '📨 Передаю задачу агенту…',
      lastMsgId ? { reply_to_message_id: lastMsgId, allow_sending_without_reply: true } : {},
    ).catch(() => null);

    // The collector ("Принял N, жми «Запустить»") is stale procedural noise once
    // the task has actually launched — delete it outright rather than leaving an
    // edited "▶️ Запустил проработку" husk in the chat (owner request 2026-09-22).
    // Only fall back to a neutral, button-less edit if the placeholder above
    // failed to send, since then this message id is still needed below as the
    // streaming target.
    if (collectorMsgId && chatId) {
      if (placeholderRes?.result?.message_id) {
        await deleteMessage(this.env.BOT_TOKEN, chatId, collectorMsgId).catch(() => {});
      } else {
        await editMessage(this.env.BOT_TOKEN, chatId, collectorMsgId, '▶️ Запустил проработку', {
          reply_markup: { inline_keyboard: [] },
        }).catch(() => {});
      }
    }
    const initialMsgId = placeholderRes?.result?.message_id ?? collectorMsgId ?? null;

    // Safety net: only fires if the run's isolate dies before finally clears busy.
    await this.state.storage.setAlarm(Date.now() + BUSY_MAX_MS);

    try {
      // Dynamic import avoids a circular import at module load.
      // mode:'deep' — «▶️ Запустить проработку» запускает НАДЁЖНУЮ (deep) сессию на всём
      // накопленном буфере (#530 §A/§B: единый явный запуск проработки). Утилитарные
      // запросы всё равно перехватит быстрый ответ агента (runQuickAnswer) до deep-пути.
      const { handleMessage } = await import('./handlers/message.js');
      await handleMessage(msg, this.env, { mode: 'deep', initialMsgId,
        onIntakePrepared: async (index, prepared) => {
          buf[index] = { ...buf[index], msg: prepared };
          await this.state.storage.put('launching', buf);
        },
      });
      await this.state.storage.delete('launching');
      await this.state.storage.delete('retryBatchAttempts');
    } catch (err) {
      // Stop automatic retries after three failures, but preserve the complete
      // batch and preparation progress for explicit recovery. New input stays usable.
      const isPrepFailure = err?.code === 'INTAKE_PREPARATION_FAILED';
      const attempts = isPrepFailure ? ((await this.state.storage.get('retryBatchAttempts')) || 0) + 1 : 0;
      const giveUp = isPrepFailure && attempts >= 3;
      const failureId = giveUp ? crypto.randomUUID() : null;
      await this._exclusive(async () => this.state.storage.transaction(async tx => {
        if (giveUp) {
          await tx.put(`failed:${failureId}`, { id: failureId, items: buf, failedAt: Date.now(),
            messageId: err.intakeMessageId || null, status: err.cause?.status || null });
          await tx.delete('retryBatchAttempts');
        } else {
          await tx.put('retryBatch', buf);
          if (isPrepFailure) await tx.put('retryBatchAttempts', attempts);
        }
        await tx.delete('launching');
      }));
      await sendMessage(this.env.BOT_TOKEN, chatId,
        giveUp
          ? '⚠️ Вложение не удалось подготовить после нескольких попыток. Сообщения и готовые расшифровки сохранены для восстановления. Новые задачи можно отправлять; для возврата этой пачки обратись в поддержку.'
          : isPrepFailure
          ? '⚠️ Не удалось подготовить вложение. Пачка и ссылки на исходные сообщения сохранены. Повтори запуск позже — отправлять всё заново не нужно.'
          : '⚠️ Подтверждение запуска не получено. Вся пачка сохранена — повторный запуск проверит, была ли задача уже принята, и не создаст дубль.');
      console.error(`[intake ${chatId}] batch preparation failed (attempt ${attempts || 1}${giveUp ? ', gave up' : ''}):`, err?.cause?.message || err?.message);
    } finally {
      await this.state.storage.delete('busy');
      await this.state.storage.delete('busySince');
      await this.state.storage.deleteAlarm();
      await this._recoverMedia();
      const remaining = [...((await this.state.storage.get('retryBatch')) || []), ...((await this.state.storage.get('buf')) || [])];
      if (remaining.length && chatId) {
        // Messages piled up mid-run — surface a fresh launch button, never auto-run.
        // Skip if media is still pending: _mediaResult will show the collector once the
        // transcript arrives, so the button never appears above the transcript in chat.
        if (!remaining.some(i => i.mediaPending)) {
          await this._showCollector(chatId, remaining.length, remaining[remaining.length - 1].msg.message_id);
        }
      }
    }
  }

  async alarm() {
    await this._recoverMedia();

    // If not busy and media still pending — _recoverMedia re-armed the alarm; wait.
    const bufCheck = (await this.state.storage.get('buf')) || [];
    if (!(await this.state.storage.get('busy')) && bufCheck.some(i => i.mediaPending)) return;

    // Check once after the quiet period, never on the two-second short-text path.
    const debounceExpiresAt = await this.state.storage.get('debounceExpiresAt');
    if (debounceExpiresAt && await this.state.storage.get('autoPolicy') !== 'quiet-3m-v1') {
      const items = (await this.state.storage.get('buf')) || [];
      if (items.length && !(await this.state.storage.get('busy'))) {
        await this._armAutoDispatch(items.at(-1).msg.chat?.id, items, items.at(-1).msg.message_id);
        return;
      }
    }
    if (debounceExpiresAt && Date.now() >= debounceExpiresAt &&
        !(await this.state.storage.get('busy'))) {
      const buf = (await this.state.storage.get('buf')) || [];
      const snapshot = JSON.stringify(buf);
      if (buf.length && !buf.some(i => i.mediaPending || i.preparingAt)) {
        const chatId = buf[buf.length - 1].msg.chat?.id;
        // Prepared file contents must not masquerade as the user's instruction.
        const intent = buf.map(i => {
          const m = i.msg || {};
          if (m.document || m.photo || m.video) return i.intentText ?? m.caption ?? '';
          return coalesceItem(i);
        }).filter(Boolean).join('\n');
        let verdict = { level: 'insufficient' };
        try {
          if (intent.trim()) verdict = await checkCompleteness(this.env, { text: intent });
        } catch { /* Leave input intact and offer manual launch. */ }
        const current = await this._exclusive(async () => {
          if (JSON.stringify((await this.state.storage.get('buf')) || []) !== snapshot ||
              await this.state.storage.get('debounceExpiresAt') !== debounceExpiresAt ||
              await this.state.storage.get('busy')) return false;
          await this.state.storage.delete('debounceExpiresAt');
          await this.state.storage.delete('gateLevel');
          return true;
        });
        if (!current) return;
        if (verdict?.level === 'clear' || verdict?.level === 'likely') {
          await this._dispatch(snapshot);
        } else if (chatId) {
          await sendMessage(this.env.BOT_TOKEN, chatId, insufficientText);
        }
        return;
      }
    }
    // ── End debounce ────────────────────────────────────────────────────────────

    // Busy release: if a run's isolate died before its finally cleared `busy`, release it.
    // Also re-offer the launch button after releasing the hold.
    if ((await this.state.storage.get('busy')) === true) {
      const since = (await this.state.storage.get('busySince')) || 0;
      if (Date.now() - since < BUSY_MAX_MS) {
        await this.state.storage.setAlarm(Math.min(since + BUSY_MAX_MS, Date.now() + 60000));
        return;
      }
      await this._exclusive(async () => {
        const launching = (await this.state.storage.get('launching')) || [];
        const remaining = (await this.state.storage.get('buf')) || [];
        if (launching.length) await this.state.storage.put('retryBatch', launching);
        await this.state.storage.delete('launching');
        await this.state.storage.delete('busy');
        await this.state.storage.delete('busySince');
      });
    }
    const buf = [...((await this.state.storage.get('retryBatch')) || []), ...((await this.state.storage.get('buf')) || [])];
    if (buf.length) {
      const last = buf[buf.length - 1].msg;
      await this._showCollector(last.chat?.id, buf.length, last.message_id);
    }
  }
}

function json(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { 'content-type': 'application/json' },
  });
}
