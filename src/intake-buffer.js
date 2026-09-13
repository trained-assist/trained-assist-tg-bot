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

import { sendMessageWithKeyboard, editMessage } from './lib/telegram.js';

const BUSY_MAX_MS = 45 * 60_000; // safety: release a run marked busy whose isolate
                                 // died mid-flight. Must exceed the longest
                                 // legitimate session (~40 min agent cap).

const LAUNCH_BTN = [[{ text: '▶️ Запустить проработку', callback_data: 'intake_run' }]];

const collectorText = n =>
  `📥 Принял ✅ Накапливаю (${n}). Пиши ещё — или жми «▶️ Запустить проработку», когда закончишь.`;

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
        // A run is in flight — accumulate silently; surfaced after it finishes.
        return json({ buffered: buf.length, held: true });
      }
      if (flush) {
        // Force word (запускай/го) — launch immediately, coalescing everything.
        await this._dispatch();
        return json({ flushed: true });
      }
      // Idle: (re)show the launch button with the live count. No timer.
      await this._showCollector(msg.chat?.id, buf.length);
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

  // Show or refresh the single collector message carrying the launch button.
  async _showCollector(chatId, count) {
    if (!chatId) return;
    const msgId = await this.state.storage.get('collectorMsgId');
    if (msgId) {
      const r = await editMessage(this.env.BOT_TOKEN, chatId, msgId, collectorText(count), {
        reply_markup: { inline_keyboard: LAUNCH_BTN },
      }).catch(() => null);
      if (r && r.ok) return;
      // Edit failed (message deleted / too old) — fall through and post a new one.
    }
    const sent = await sendMessageWithKeyboard(
      this.env.BOT_TOKEN, chatId, collectorText(count), LAUNCH_BTN,
    ).catch(() => null);
    const newId = sent?.result?.message_id;
    if (newId) await this.state.storage.put('collectorMsgId', newId);
  }

  // Coalesce the buffer into one message and run it. Marks the chat busy so
  // anything sent during the run is held (surfaced with a new button afterwards).
  async _dispatch() {
    const buf = (await this.state.storage.get('buf')) || [];
    if (!buf.length) return;

    const base = buf[buf.length - 1].msg;
    const chatId = base.chat?.id;
    const coalescedText = buf.map(i => i.text).filter(Boolean).join('\n');
    const msg = { ...base, text: coalescedText };

    // Retire the collector button so it can't be tapped twice.
    const collectorMsgId = await this.state.storage.get('collectorMsgId');
    if (collectorMsgId && chatId) {
      await editMessage(this.env.BOT_TOKEN, chatId, collectorMsgId, '⚙️ Запускаю…', {
        reply_markup: { inline_keyboard: [] },
      }).catch(() => {});
    }
    await this.state.storage.delete('collectorMsgId');
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
      await handleMessage(msg, this.env, { mode: 'deep' });
    } finally {
      await this.state.storage.delete('busy');
      await this.state.storage.delete('busySince');
      await this.state.storage.deleteAlarm();
      const remaining = (await this.state.storage.get('buf')) || [];
      if (remaining.length && chatId) {
        // Messages piled up mid-run — surface a fresh launch button, never auto-run.
        await this._showCollector(chatId, remaining.length);
      }
    }
  }

  async alarm() {
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
      await this._showCollector(buf[buf.length - 1].msg.chat?.id, buf.length);
    }
  }
}

function json(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { 'content-type': 'application/json' },
  });
}
