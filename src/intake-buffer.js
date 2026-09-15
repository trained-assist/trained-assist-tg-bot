// Durable Object: per-chat intake buffer.
//
// Model (manual launch, no timer): the bot ALWAYS accumulates a user's plain-text
// messages and never fires on its own. The user launches the run explicitly — by
// tapping «▶️ Запустить» on the collector message, or by typing a force word
// (запускай / го / поехали, see index.js). This replaces the old 10s debounce:
// once the launch is a deliberate button press, guessing "did the user finish
// typing?" (silence timer + LLM completeness nudge) is dead weight, so it's gone.
//
// Two states, both owned here so the rule is one place for every user:
//   • idle     — messages pile into `buf`; a single collector message shows the
//                launch button and its live count. No alarm is armed.
//   • busy     — a run is in flight for this chat: new messages accumulate
//                silently and are surfaced with a fresh launch button once the run
//                finishes (never auto-dispatched).
//
// One instance per chat_id (idFromName(chatId)). DO fetch/alarm handlers are
// serialised per instance, so /append, /flush and the safety alarm never race.
// The ONLY alarm is a safety net: if a run's isolate dies before clearing `busy`,
// BUSY_MAX_MS releases the hold so the buffer can't be trapped forever.

import { sendMessage, sendMessageWithKeyboard, editMessage, editMessageReplyMarkup } from './lib/telegram.js';
import { coalesceBuffer } from './intake-routing.js';

// Reply-anchor a new message to the one that triggered it — the only way a fresh
// bubble reliably appears right after the user's own message once the chat has
// scrolled (an edit to an older bubble is invisible off-screen). Best-effort:
// if the source message was since deleted, still deliver un-anchored.
const anchor = messageId => (messageId ? { reply_to_message_id: messageId, allow_sending_without_reply: true } : {});

const BUSY_MAX_MS = 45 * 60_000; // safety: release a run marked busy whose isolate
                                 // died mid-flight. Must exceed the longest
                                 // legitimate session (~40 min agent cap).

const LAUNCH_BTN = [[{ text: '▶️ Запустить проработку', callback_data: 'intake_run' }]];

const collectorText = n =>
  `📥 Принял ✅ Накапливаю (${n}). Можешь дополнить — или жми «▶️ Запустить проработку», когда закончишь.`;

// Shown while a run is in flight: the buffer holds new messages (never auto-runs),
// but the user MUST still see they were received. Silence here was the «спросил
// "работает" — молчит» bug — a busy hold produced no Telegram output at all.
const heldText = n =>
  `⏳ Иду по текущей задаче. Принял ещё (${n}) — покажу кнопку «▶️ Запустить», как закончу.`;

export class IntakeBuffer {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/append' && request.method === 'POST') {
      const { text, msg, flush } = await request.json();
      const buf = (await this.state.storage.get('buf')) || [];
      buf.push({ text, msg });
      await this.state.storage.put('buf', buf);

      if ((await this.state.storage.get('busy')) === true) {
        // A run is in flight — hold new messages (never auto-run), but ACK them so
        // the user isn't met with silence. A fresh launch button is offered once
        // the run finishes; here we only confirm receipt.
        await this._showHeldNotice(msg.chat?.id, buf.length, msg.message_id);
        return json({ buffered: buf.length, held: true });
      }
      if (flush) {
        // Force word (запускай/го) — launch immediately, coalescing everything.
        await this._dispatch();
        return json({ flushed: true });
      }
      // Idle: (re)show the launch button with the live count. No timer.
      await this._showCollector(msg.chat?.id, buf.length, msg.message_id);
      return json({ buffered: buf.length });
    }

    if (url.pathname === '/flush' && request.method === 'POST') {
      // Button tap. If a run is somehow already going, ignore (don't double-fire).
      if ((await this.state.storage.get('busy')) === true) return json({ busy: true });
      const buf = (await this.state.storage.get('buf')) || [];
      if (!buf.length) return json({ empty: true });
      await this._dispatch();
      return json({ flushed: true });
    }

    return new Response('not found', { status: 404 });
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
    const buf = (await this.state.storage.get('buf')) || [];
    if (!buf.length) return;

    const base = buf[buf.length - 1].msg;
    const chatId = base.chat?.id;
    const coalescedText = coalesceBuffer(buf);
    const traceId = crypto.randomUUID();
    const hasMedia = buf.some(({ msg }) => msg.photo || msg.document || msg.voice || msg.audio || msg.video);
    const msg = { ...base, text: coalescedText, traceId, ...(hasMedia ? { intakeMessages: buf.map(x => x.msg) } : {}) };
    console.log(JSON.stringify({ event: 'intake.dispatch', traceId, chatId, messageIds: buf.map(x => x.msg.message_id) }));

    // Retire the collector button so it can't be tapped twice.
    const collectorMsgId = await this.state.storage.get('collectorMsgId');
    if (collectorMsgId && chatId) {
      await editMessage(this.env.BOT_TOKEN, chatId, collectorMsgId, '⚙️ Запускаю…', {
        reply_markup: { inline_keyboard: [] },
      }).catch(() => {});
    }
    await this.state.storage.delete('collectorMsgId');
    await this.state.storage.put('dispatchPacket', { traceId, chatId, messages: buf });
    await this.state.storage.delete('buf');
    await this.state.storage.put('busy', true);
    await this.state.storage.put('busySince', Date.now());
    // Safety net: only fires if the run's isolate dies before finally clears busy.
    await this.state.storage.setAlarm(Date.now() + BUSY_MAX_MS);

    try {
      // Dynamic import avoids a circular import at module load.
      // mode:'deep' — «▶️ Запустить проработку» запускает НАДЁЖНУЮ (deep) сессию на всём
      // накопленном буфере (#530 §A/§B: единый явный запуск проработки). Утилитарные
      // запросы всё равно перехватит быстрый ответ агента (runQuickAnswer) до deep-пути.
      const { handleMessage } = await import('./handlers/message.js');
      const accepted = await handleMessage(msg, this.env, { mode: 'deep' });
      if (accepted?.taskId) {
        await this.state.storage.put('activeRun', { taskId: accepted.taskId, agentUrl: accepted.agentUrl || this.env.AGENT_URL, traceId, chatId });
        await this.state.storage.setAlarm(Date.now() + 15_000);
      }
    } catch (error) {
      if (error.delivery === 'unknown') {
        await this.state.storage.put('activeRun', {
          taskId: error.taskId, agentUrl: error.agentUrl, traceId, chatId,
        });
        await this.state.storage.setAlarm(Date.now() + 15_000);
        await sendMessage(this.env.BOT_TOKEN, chatId,
          'Не удалось подтвердить запуск. Пакет сохранён, проверяю статус — повторно не отправляй.');
        return;
      }
      const pending = (await this.state.storage.get('buf')) || [];
      await this.state.storage.put('buf', [...buf, ...pending]);
      await sendMessage(this.env.BOT_TOKEN, chatId, 'Не удалось передать пакет. Сообщения сохранены — можно повторить запуск.');
      console.error(JSON.stringify({ event: 'intake.failed', traceId }));
    } finally {
      if (await this.state.storage.get('activeRun')) return;
      await this.state.storage.delete('dispatchPacket');
      await this.state.storage.delete('busy');
      await this.state.storage.delete('busySince');
      await this.state.storage.deleteAlarm();
      const remaining = (await this.state.storage.get('buf')) || [];
      if (remaining.length && chatId) {
        // Messages piled up mid-run — surface a fresh launch button, never auto-run.
        await this._showCollector(chatId, remaining.length, remaining[remaining.length - 1].msg.message_id);
      }
    }
  }

  async alarm() {
    const active = await this.state.storage.get('activeRun');
    if (active) {
      try {
        const response = await fetch(`${active.agentUrl}/tasks/status?taskId=${encodeURIComponent(active.taskId)}`, {
          headers: { Authorization: `Bearer ${this.env.AGENT_SECRET}` }, signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error('status unavailable');
        const status = await response.json();
        if (!['settled', 'failed'].includes(status.state)) throw new Error('still active or unknown');
        console.log(JSON.stringify({ event: 'intake.finished', traceId: active.traceId, taskId: active.taskId, state: status.state }));
        await this.state.storage.delete('dispatchPacket');
        await this.state.storage.delete('activeRun');
        await this.state.storage.delete('busy');
        await this.state.storage.delete('busySince');
      } catch {
        // Unknown (including agent restart) is not proof of completion.
        await this.state.storage.setAlarm(Date.now() + 15_000);
        return;
      }
    }

    // An isolate can die after POST but before persisting its acknowledgement.
    // Keep the packet for reconciliation; elapsed time proves neither rejection
    // nor completion and must never cause duplicate execution.
    if (await this.state.storage.get('dispatchPacket')) {
      await this.state.storage.setAlarm(Date.now() + 15_000);
      return;
    }

    // Only the BUSY_MAX safety net reaches here: a run whose isolate died before
    // its finally cleared `busy`. Release the hold and re-offer the launch button.
    if ((await this.state.storage.get('busy')) === true) {
      const since = (await this.state.storage.get('busySince')) || 0;
      if (Date.now() - since < BUSY_MAX_MS) {
        await this.state.storage.setAlarm(since + BUSY_MAX_MS);
        return;
      }
      await this.state.storage.delete('busy');
      await this.state.storage.delete('busySince');
    }
    const buf = (await this.state.storage.get('buf')) || [];
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
