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
// can interleave at external awaits. Short state mutations use an explicit lock;
// Telegram and transcription I/O must never hold that lock.
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
  `📥 Принял ✅ Накапливаю (${n}). Можешь дополнить текстом, фото или голосовым — или жми «▶️ Запустить проработку», когда закончишь.`;

// Shown while a run is in flight: the buffer holds new messages (never auto-runs),
// but the user MUST still see they were received. Silence here was the «спросил
// "работает" — молчит» bug — a busy hold produced no Telegram output at all.
const heldText = n =>
  `⏳ Иду по текущей задаче. Принял ещё (${n}) — покажу кнопку «▶️ Запустить», как закончу.`;

export class IntakeBuffer {
  constructor(state, env) {
    this.state = state;
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

  async _controlFor(items = []) {
    let sessionId = items.find(x => x.msg?.intakeRoute?.sessionId)?.msg.intakeRoute.sessionId;
    const chatId = items[0]?.msg?.chat?.id ?? await this.state.storage.get('chatId');
    if (!sessionId && this.env.SESSIONS && chatId != null) {
      const { getSession } = await import('./lib/kv.js');
      const session = await getSession(this.env.SESSIONS, chatId);
      sessionId = session?.activeSessionId || session?.lastSessionId || null;
    }
    const key = `control:${sessionId || 'chat'}`;
    return { key, sessionId, state: (await this.state.storage.get(key)) || {} };
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/pause' && request.method === 'POST') {
      const { chatId, sessionId } = await request.json();
      await this.state.storage.put('chatId', chatId);
      await this._exclusive(async () => {
        const generation = ((await this.state.storage.get('generation')) || 0) + 1;
        await this.state.storage.put(`control:${sessionId || 'chat'}`, { paused: true, fenceReady: false, generation });
        await this.state.storage.put('generation', generation);
      });
      return json({ paused: true, generation: await this.state.storage.get('generation') });
    }
    if (url.pathname === '/fence' && request.method === 'POST') {
      const { generation, epoch, epochs, sessionId } = await request.json();
      await this._exclusive(async () => {
        const key = `control:${sessionId || 'chat'}`;
        const control = (await this.state.storage.get(key)) || {};
        if (generation !== control.generation) return;
        await this.state.storage.put(key, { ...control, epoch, epochs, fenceReady: true });
      });
      return json({ ok: true });
    }
    if (url.pathname === '/check-generation' && request.method === 'POST') {
      const { generation } = await request.json();
      return json({ current: generation === ((await this.state.storage.get('generation')) || 0) });
    }
    if (url.pathname === '/skip-ready' && request.method === 'POST') {
      const { sessionId, generation } = await request.json();
      await this._exclusive(async () => {
        const key = `control:${sessionId || 'chat'}`;
        const control = (await this.state.storage.get(key)) || {};
        if (control.generation !== generation) return;
        await this.state.storage.put(key, { ...control, paused: false });
        await this.state.storage.put('skipGeneration', generation);
        if (await this.state.storage.get('busy')) await this.state.storage.put('skipPending', true);
      });
      return json({ ok: true });
    }
    if (url.pathname === '/fresh' && request.method === 'POST') {
      const { sessionId } = await request.json();
      await this._exclusive(async () => {
        const buf = (await this.state.storage.get('buf')) || [];
        const launching = (await this.state.storage.get('launching')) || [];
        // Exclude from launch, retain history/media references durably.
        await this.state.storage.put(`archived:${Date.now()}`, [...launching, ...buf]);
        await this.state.storage.put('freshGeneration', (await this.state.storage.get('generation')) || 0);
        await this.state.storage.delete('buf');
        await this.state.storage.delete('launching');
        await this.state.storage.delete(`control:${sessionId || 'chat'}`);
      });
      return json({ fresh: true });
    }

    if (url.pathname === '/ingest' && request.method === 'POST') {
      const { msg } = await request.json();
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
          '⚠️ Не удалось подготовить сообщение сразу. Оно сохранено; повторю при запуске проработки.');
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
        if (await this.state.storage.get('busy')) await this._showHeldNotice(msg.chat.id, remaining.length, msg.message_id);
        else await this._showCollector(msg.chat.id, remaining.length, msg.message_id);
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
      // Idle: (re)show the launch button with the live count. No timer.
      await this._showCollector(msg.chat?.id, buf.length, msg.message_id);
      return json({ buffered: buf.length });
    }

    if (url.pathname === '/flush' && request.method === 'POST') {
      const control = await this._controlFor((await this.state.storage.get('buf')) || []);
      if (control.state.paused && !control.state.fenceReady) return json({ stopping: true });
      // Button tap. If a run is somehow already going, ignore (don't double-fire).
      if ((await this.state.storage.get('busy')) === true) return json({ busy: true });
      let buf = (await this.state.storage.get('buf')) || [];
      if (!buf.length && control.state.paused) {
        const chatId = await this.state.storage.get('chatId');
        if (chatId != null) {
          buf = [{ text: '[Явный повторный запуск остановленной сессии]', msg: { chat: { id: chatId }, message_id: 0 } }];
          await this.state.storage.put('buf', buf);
        }
      }
      if (!buf.length) return json({ empty: true });
      const pending = buf.some(i => i.preparingAt && Date.now() - i.preparingAt < 120000);
      if (pending) {
        await sendMessage(this.env.BOT_TOKEN, buf[0].msg.chat.id, '⏳ Ещё расшифровываю полученные сообщения. Нажми запуск после расшифровки — пачка сохранена.');
        return json({ preparing: true });
      }
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
    // Serialize collector delivery: overlapping voice/text completions must not
    // retire each other's only usable button. Data ingestion has its own lock.
    const previous = this.collectorDelivery || Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      const prevId = await this.state.storage.get('collectorMsgId');
      const sent = await sendMessageWithKeyboard(
        this.env.BOT_TOKEN, chatId, collectorText(count), LAUNCH_BTN, anchor(replyToMessageId),
      ).catch(err => { console.error('[intake] collector delivery:', err.message); return null; });
      const newId = sent?.ok !== false && sent?.result?.message_id;
      if (newId) {
        await this.state.storage.put('collectorMsgId', newId);
        if (prevId) await editMessageReplyMarkup(this.env.BOT_TOKEN, chatId, prevId, [])
          .catch(err => console.error('[intake] retire collector:', err.message));
        await this.state.storage.delete('collectorRetry');
        return;
      }
      // Never replace the pointer with a buttonless message. The old button
      // remains usable, and a durable alarm repairs delivery after an outage.
      await this.state.storage.put('collectorRetry', { chatId, replyToMessageId });
      await this.state.storage.setAlarm(Date.now() + 15000);
      await sendMessage(this.env.BOT_TOKEN, chatId,
        `📥 Сообщения сохранены (${count}). Кнопку не удалось доставить. Напиши «запускай» или нажми предыдущую кнопку запуска.`,
        anchor(replyToMessageId)).catch(err => console.error('[intake] fallback:', err.message));
    });
    this.collectorDelivery = current;
    return current;
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
    const generation = (await this.state.storage.get('generation')) || 0;
    const buf = await this._exclusive(async () => {
      if (await this.state.storage.get('busy')) return [];
      const items = (await this.state.storage.get('buf')) || [];
      if (!items.length) return [];
      if (items.some(i => i.preparingAt && Date.now() - i.preparingAt < 120000)) return [];
      items.sort((a, b) => (a.msg.message_id || 0) - (b.msg.message_id || 0));
      await this.state.storage.put('busy', true);
      await this.state.storage.put('busySince', Date.now());
      await this.state.storage.put('launching', items);
      await this.state.storage.setAlarm(Date.now() + BUSY_MAX_MS);
      await this.state.storage.delete('buf');
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
    const collectorMsgId = await this.state.storage.get('collectorMsgId');
    if (collectorMsgId && chatId) {
      await editMessage(this.env.BOT_TOKEN, chatId, collectorMsgId, '📨 Передаю задачу агенту…', {
        reply_markup: { inline_keyboard: [] },
      }).catch(() => {});
    }
    await this.state.storage.delete('collectorMsgId');
    // Safety net: only fires if the run's isolate dies before finally clears busy.
    await this.state.storage.setAlarm(Date.now() + BUSY_MAX_MS);

    try {
      // Dynamic import avoids a circular import at module load.
      // mode:'deep' — «▶️ Запустить проработку» запускает НАДЁЖНУЮ (deep) сессию на всём
      // накопленном буфере (#530 §A/§B: единый явный запуск проработки). Утилитарные
      // запросы всё равно перехватит быстрый ответ агента (runQuickAnswer) до deep-пути.
      const { handleMessage } = await import('./handlers/message.js');
      if (((await this.state.storage.get('generation')) || 0) !== generation) throw new Error('Сессия остановлена во время подготовки');
      const control = await this._controlFor(buf);
      const controlEpoch = control.state.epoch || 0;
      const controlEpochs = control.state.epochs;
      if (this.env.SESSIONS && control.state.paused) {
        const { getSession } = await import('./lib/kv.js');
        const { stopTask } = await import('./lib/agent-client.js');
        const session = await getSession(this.env.SESSIONS, chatId);
        if (!session) throw new Error('Войди в профиль перед запуском');
        const target = { username: session.username, chatId,
          sessionId: msg.intakeRoute?.sessionId || session.activeSessionId || session.lastSessionId || null };
        if (((await this.state.storage.get('generation')) || 0) !== generation) throw new Error('Сессия остановлена');
        const resumed = await stopTask(this.env, { ...target, action: 'resume', expectedEpoch: controlEpoch, expectedEpochs: controlEpochs });
        const held = resumed.held || [];
        if (held.length) {
          const text = '[Сохранённый незавершённый ввод]\n' + held.map(x => [x.context, x.task].filter(Boolean).join('\n')).join('\n\n');
          const retained = { text, msg: { chat: { id: chatId }, message_id: 0 } };
          buf.unshift(retained);
          msg.intakeItems = buf;
          msg.text = coalesceBuffer(buf);
          // Durable local handoff precedes server acknowledgement.
          await this.state.storage.put('launching', buf);
          await stopTask(this.env, { ...target, action: 'ack', taskIds: held.map(x => x.taskId) });
        }
        if (((await this.state.storage.get('generation')) || 0) !== generation) throw new Error('Сессия остановлена');
        await this.state.storage.put(control.key, { ...control.state, paused: false });
      }
      await handleMessage(msg, this.env, { mode: 'deep', initialMsgId: collectorMsgId || null, ...(controlEpoch ? { controlEpoch } : {}), ...(controlEpochs ? { controlEpochs } : {}), intakeGeneration: generation });
      await this.state.storage.delete('launching');
    } catch (err) {
      // Preparation failed: keep the original Telegram references, never launch
      // a partial task or require the user to dictate everything again.
      await this._exclusive(async () => {
        const remaining = (await this.state.storage.get('buf')) || [];
        if (Math.max((await this.state.storage.get('freshGeneration')) || 0, (await this.state.storage.get('skipGeneration')) || 0) > generation) {
          await this.state.storage.put(`archived-dispatch:${Date.now()}`, buf);
        } else await this.state.storage.put('buf', [...buf, ...remaining]);
        await this.state.storage.delete('launching');
      });
      await sendMessage(this.env.BOT_TOKEN, chatId,
        '⚠️ Не удалось подготовить все сообщения. Вся пачка сохранена — нажми «▶️ Запустить проработку», чтобы повторить.');
      console.error(`[intake ${chatId}] batch preparation failed:`, err?.message);
    } finally {
      await this.state.storage.delete('busy');
      await this.state.storage.delete('busySince');
      await this.state.storage.deleteAlarm();
      const remaining = (await this.state.storage.get('buf')) || [];
      if (await this.state.storage.get('skipPending')) {
        await this.state.storage.delete('skipPending');
        if (remaining.length) await this._dispatch();
        return;
      }
      if (remaining.length && chatId) {
        // Messages piled up mid-run — surface a fresh launch button, never auto-run.
        await this._showCollector(chatId, remaining.length, remaining[remaining.length - 1].msg.message_id);
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
      await this._exclusive(async () => {
        const launching = (await this.state.storage.get('launching')) || [];
        const remaining = (await this.state.storage.get('buf')) || [];
        if (launching.length) await this.state.storage.put('buf', [...launching, ...remaining]);
        await this.state.storage.delete('launching');
        await this.state.storage.delete('busy');
        await this.state.storage.delete('busySince');
      });
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
