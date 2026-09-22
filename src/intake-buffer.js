import { mediaEnabled, mediaOf, mediaId, enqueueMedia, needsTranscript } from './media-jobs.js';
import { getSession } from './lib/kv.js';
import { checkCompleteness } from './lib/agent-client.js';
// Durable Object: per-chat intake buffer.
//
// Model (smart debounce + manual launch): the bot accumulates a user's plain-text
// messages and auto-dispatches after DEBOUNCE_MS of silence if the task looks
// complete. If the completeness gate says the thought is unfinished, the user gets
// a single nudge ("мысль не закончена, допиши") and a SOFT_REARM_MS grace period;
// after that second timer fires (or if the user already received the nudge), the
// task is dispatched regardless. The user can also launch explicitly — by tapping
// «▶️ Запустить» on the collector message, or by typing a force word (запускай / го
// / поехали, see index.js).
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

import { sendMessage, sendDocument, sendMessageWithKeyboard, editMessage, editMessageReplyMarkup } from './lib/telegram.js';
import { coalesceBuffer, SHORT_MSG_THRESHOLD } from './intake-routing.js';

// Reply-anchor a new message to the one that triggered it — the only way a fresh
// bubble reliably appears right after the user's own message once the chat has
// scrolled (an edit to an older bubble is invisible off-screen). Best-effort:
// if the source message was since deleted, still deliver un-anchored.
const anchor = messageId => (messageId ? { reply_to_message_id: messageId, allow_sending_without_reply: true } : {});

const BUSY_MAX_MS = 45 * 60_000; // safety: release a run marked busy whose isolate
                                 // died mid-flight. Must exceed the longest
                                 // legitimate session (~40 min agent cap).
const DEBOUNCE_MS = 10_000;      // auto-launch delay after last message when task looks complete
const SHORT_DEBOUNCE_MS = 2_000; // reduced debounce for short follow-up messages (≤ SHORT_MSG_THRESHOLD chars)
const SOFT_REARM_MS = 15_000;    // grace period after "incomplete" nudge before force-dispatch

const LAUNCH_BTN = [[{ text: '▶️ Запустить проработку', callback_data: 'intake_run' }]];

const collectorText = n =>
  `📥 Принял ✅ Накапливаю (${n}). Можешь дополнить текстом, фото или голосовым — или жми «▶️ Запустить проработку», когда закончишь.`;

// Shown while a run is in flight: the buffer holds new messages (never auto-runs),
// but the user MUST still see they were received. Silence here was the «спросил
// "работает" — молчит» bug — a busy hold produced no Telegram output at all.
const heldText = n =>
  `⏳ Иду по текущей задаче. Принял ещё (${n}) — покажу кнопку «▶️ Запустить», как закончу.`;

export class IntakeBuffer {
  constructor(state, env) {
    this.state = state;
    // Apply the same SESSION_NAMESPACE wrapping as dispatchInner — DO receives env
    // directly from the Workers runtime so it can't piggyback on the fetch-handler
    // wrapper. Without this, session reads inside the DO ignore the namespace and
    // can find sessions from a different bot (cross-bot auto-login bug).
    if (env.SESSION_NAMESPACE) {
      const ns = env.SESSION_NAMESPACE;
      const raw = env.SESSIONS;
      env = { ...env, SESSIONS: {
        get: k => raw.get(`${ns}:${k}`),
        put: (k, v, opts) => raw.put(`${ns}:${k}`, v, opts),
        delete: k => raw.delete(`${ns}:${k}`),
        list: opts => raw.list(opts),
      }};
    }
    this.env = env;
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

    if (url.pathname === '/media-result' && request.method === 'POST') {
      return this._mediaResult(await request.json());
    }

    if (url.pathname === '/ingest' && request.method === 'POST') {
      const { msg } = await request.json();
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
        result = await preflight(msg, this.env);
      } catch (error) {
        await sendMessage(this.env.BOT_TOKEN, msg.chat.id,
          '⚠️ Сообщение сохранено для повтора, но подготовка файла или расшифровки ещё не завершена. Повторю при запуске проработки.');
        console.warn('[intake prepare]', error.message);
      }
      await this._exclusive(async () => {
        const items = (await this.state.storage.get('buf')) || [];
        const index = items.findIndex(i => i.msg.message_id === msg.message_id);
        if (index >= 0) {
          if (result.handled) items.splice(index, 1);
          else items[index] = { text: result.msg.text, msg: result.msg };
        }
        await this.state.storage.put('buf', items);
        const seen = (await this.state.storage.get('received')) || [];
        await this.state.storage.put('received', [...seen, msg.message_id].slice(-1000));
      });
      if (result.handled) return json({ handled: true });
      const remaining = (await this.state.storage.get('buf')) || [];
      if (remaining.length) {
        if (await this.state.storage.get('busy')) {
          await this._showHeldNotice(msg.chat.id, remaining.length, msg.message_id);
        } else {
          // Idle: arm the debounce timer and show the launch button.
          // Short follow-ups (≤ SHORT_MSG_THRESHOLD chars, no pending media) use a 2-second
          // debounce and skip the completeness-nudge — they are almost always self-contained.
          await this.state.storage.delete('nudged');
          const msgText = (msg.text || '').trim();
          const isShort = !remaining.some(i => i.mediaPending) && msgText.length > 0 && msgText.length <= SHORT_MSG_THRESHOLD;
          const debounceMs = isShort ? SHORT_DEBOUNCE_MS : DEBOUNCE_MS;
          if (isShort) await this.state.storage.put('shortDebounce', true);
          else await this.state.storage.delete('shortDebounce');
          const expiresAt = Date.now() + debounceMs;
          await this.state.storage.put('debounceExpiresAt', expiresAt);
          await this.state.storage.setAlarm(expiresAt);
          await this._showCollector(msg.chat.id, remaining.length, msg.message_id);
        }
      }
      return json({ buffered: remaining.length });
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
      await this.state.storage.delete('nudged');
      const expiresAt = Date.now() + DEBOUNCE_MS;
      await this.state.storage.put('debounceExpiresAt', expiresAt);
      await this.state.storage.setAlarm(expiresAt);
      await this._showCollector(msg.chat?.id, buf.length, msg.message_id);
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
      await this.state.storage.delete('nudged');
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
      const receiptText = needsTranscript(msg)
        ? '🎙 Принял голосовое, расшифровываю…' : '📎 Принял вложение, сохраняю…';
      await sendMessage(this.env.BOT_TOKEN, msg.chat.id,
        receiptText, anchor(msg.message_id)).catch(() => {});
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
      // After the transcript arrives, show a fresh launch button so the user
      // doesn't have to find and tap the old collector. Without this, users saw
      // the transcript but had no obvious next step ("Нажми запуск после
      // расшифровки" was confusing because the old button was scrolled off-screen).
      if (!result.error) {
        const remaining = (await this.state.storage.get('buf')) || [];
        const busy = await this.state.storage.get('busy');
        if (!busy && remaining.length && !remaining.some(i => i.mediaPending)) {
          await this._showCollector(notify.chatId, remaining.length, notify.messageId);
        }
      }
    }
    return response;
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
  async _dispatch() {
    const buf = await this._exclusive(async () => {
      if (await this.state.storage.get('busy')) return [];
      // Cancel any pending debounce alarm — dispatch is happening now (manually or
      // via the timer itself). Without this the alarm could fire a second dispatch.
      await this.state.storage.delete('debounceExpiresAt');
      await this.state.storage.delete('nudged');
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

    // Retire the collector button so it can't be tapped twice.
    // Do NOT stream the agent response into the old collector — it may have been
    // sent before the voice transcript was posted (the collector's message_id is
    // lower, so it appears above the transcript in the chat). Instead, edit it
    // to a neutral "launched" state and send a fresh placeholder whose message_id
    // is guaranteed to be higher than any already-posted transcript.
    const collectorMsgId = await this.state.storage.get('collectorMsgId');
    if (collectorMsgId && chatId) {
      await editMessage(this.env.BOT_TOKEN, chatId, collectorMsgId, '▶️ Запустил проработку', {
        reply_markup: { inline_keyboard: [] },
      }).catch(() => {});
    }
    await this.state.storage.delete('collectorMsgId');

    // Send a fresh placeholder anchored to the last user message. This message
    // is always below whatever transcript was already posted, so the agent
    // response will appear below the transcript — correct reading order.
    const lastMsgId = base.message_id || null;
    const placeholderRes = await sendMessage(
      this.env.BOT_TOKEN, chatId, '📨 Передаю задачу агенту…',
      lastMsgId ? { reply_to_message_id: lastMsgId, allow_sending_without_reply: true } : {},
    ).catch(() => null);
    const initialMsgId = placeholderRes?.result?.message_id ?? collectorMsgId ?? null;

    // Safety net: only fires if the run's isolate dies before finally clears busy.
    await this.state.storage.setAlarm(Date.now() + BUSY_MAX_MS);

    try {
      // Dynamic import avoids a circular import at module load.
      // mode:'deep' — «▶️ Запустить проработку» запускает НАДЁЖНУЮ (deep) сессию на всём
      // накопленном буфере (#530 §A/§B: единый явный запуск проработки). Утилитарные
      // запросы всё равно перехватит быстрый ответ агента (runQuickAnswer) до deep-пути.
      const { handleMessage } = await import('./handlers/message.js');
      await handleMessage(msg, this.env, { mode: 'deep', initialMsgId });
      await this.state.storage.delete('launching');
    } catch (err) {
      // Preparation failed: keep the original Telegram references, never launch
      // a partial task or require the user to dictate everything again.
      await this._exclusive(async () => {
        await this.state.storage.put('retryBatch', buf);
        await this.state.storage.delete('launching');
      });
      await sendMessage(this.env.BOT_TOKEN, chatId,
        err?.code === 'INTAKE_PREPARATION_FAILED'
          ? '⚠️ Не удалось подготовить вложение. Пачка и ссылки на исходные сообщения сохранены. Повтори запуск позже — отправлять всё заново не нужно.'
          : '⚠️ Подтверждение запуска не получено. Вся пачка сохранена — повторный запуск проверит, была ли задача уже принята, и не создаст дубль.');
      console.error(`[intake ${chatId}] batch preparation failed:`, err?.cause?.message || err?.message);
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

    // ── Debounce auto-dispatch ──────────────────────────────────────────────────
    const debounceExpiresAt = await this.state.storage.get('debounceExpiresAt');
    if (debounceExpiresAt && Date.now() >= debounceExpiresAt - 1000 &&
        !(await this.state.storage.get('busy'))) {
      await this.state.storage.delete('debounceExpiresAt');
      const buf = (await this.state.storage.get('buf')) || [];
      if (buf.length && !buf.some(i => i.mediaPending)) {
        const base = buf[buf.length - 1].msg;
        const chatId = base.chat?.id;
        const coalescedText = coalesceBuffer(buf);

        const alreadyNudged = (await this.state.storage.get('nudged')) === true;
        const isShortDebounce = (await this.state.storage.get('shortDebounce')) === true;
        await this.state.storage.delete('shortDebounce');
        if (!alreadyNudged && !isShortDebounce) {
          const { complete } = await checkCompleteness(this.env, { text: coalescedText });
          if (!complete) {
            // Task looks unfinished — nudge once, give the user more time.
            await this.state.storage.put('nudged', true);
            const expiresAt = Date.now() + SOFT_REARM_MS;
            await this.state.storage.put('debounceExpiresAt', expiresAt);
            await this.state.storage.setAlarm(expiresAt);
            if (chatId) {
              await sendMessage(
                this.env.BOT_TOKEN, chatId,
                'Не запускаю автоматически — похоже, мысль не закончена. Дополни или нажми ▶️.',
              );
            }
            return;
          }
        }

        // Complete (or already nudged, or short-debounce fast-path) → dispatch.
        await this.state.storage.delete('nudged');
        await this._dispatch();
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
