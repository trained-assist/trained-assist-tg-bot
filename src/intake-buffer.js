// Durable Object: per-chat intake buffer.
//
// Two coalescing behaviours, both owned here so the rule is one place for every user:
//
//   ШАГ 1   — debounce. A user who is still typing / sends early / wants to append
//             triggers an expensive Claude run on a half-finished thought. We
//             coalesce rapid-fire messages into one run, fired after DEBOUNCE_MS
//             of silence.
//
//   ШАГ 1.3 — busy-hold. While a session is actually running for this chat we
//             process NOTHING new: every message that arrives mid-run is buffered
//             silently (no debounce flush, no nudge). When the run finishes we go
//             back to Telegram, read everything that piled up, and dispatch it as
//             ONE coalesced message. This is the point the user made: while Claude
//             works they often want to edit / add to what they said, and firing per
//             message ruins that — so we hold until the session is free.
//
// One instance per chat_id (idFromName(chatId)). Durable Object alarm handlers are
// serialised per instance, so BUSY_MAX_MS can safely recover a buffer trapped by an
// isolate eviction mid-run without ever racing a live dispatch.

import { sendMessage } from './lib/telegram.js';
import { checkCompleteness } from './lib/agent-client.js';

const DEBOUNCE_MS = 10_000;      // silence window before flush; tune via ШАГ 1 acceptance
const SOFT_REARM_MS = 15_000;    // grace window after a "looks unfinished" nudge
const POST_RUN_MS = 4_000;       // short debounce after a run frees up, to catch a trailing edit
const BUSY_MAX_MS = 45 * 60_000; // safety: if a run never signals done (isolate evicted mid-flight),
                                 // release the hold after this so the buffer can't be trapped forever.
                                 // Must exceed the longest legitimate session (~40 min agent cap).

export class IntakeBuffer {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/append' && request.method === 'POST') {
      const item = await request.json(); // { text, msg }
      const buf = (await this.state.storage.get('buf')) || [];
      buf.push(item);
      await this.state.storage.put('buf', buf);

      const busy = (await this.state.storage.get('busy')) === true;
      if (busy) {
        // ШАГ 1.3: a session is running — accumulate silently and DON'T touch the
        // alarm. The safety alarm set at dispatch time is our only timer; the
        // buffer will be flushed by the run's own completion (see alarm()'s
        // finally), not by a debounce.
        return json({ buffered: buf.length, held: true });
      }

      // ШАГ 1: idle — (re)arm the debounce. Every new message pushes the flush
      // further out, giving the user room to finish / correct / append.
      await this.state.storage.setAlarm(Date.now() + DEBOUNCE_MS);
      return json({ buffered: buf.length });
    }
    return new Response('not found', { status: 404 });
  }

  async alarm() {
    // Busy-hold guard. If a run is (still) marked in-flight, the only way we reach
    // here is the BUSY_MAX safety alarm — a normal completion cancels its own
    // alarm in finally. Since alarm handlers are serialised, a live dispatch's
    // alarm() cannot be running concurrently, so reaching here while busy means
    // the previous run's isolate died before its finally cleared the flag.
    const busy = (await this.state.storage.get('busy')) === true;
    if (busy) {
      const since = (await this.state.storage.get('busySince')) || 0;
      if (Date.now() - since < BUSY_MAX_MS) {
        // Shouldn't normally happen; re-arm the safety and bail.
        await this.state.storage.setAlarm(since + BUSY_MAX_MS);
        return;
      }
      // Assume the run is dead — release the hold and fall through to flush.
      await this.state.storage.delete('busy');
      await this.state.storage.delete('busySince');
    }

    const buf = (await this.state.storage.get('buf')) || [];
    if (!buf.length) return;

    // Coalesce: reuse the last message envelope (chat/from/reply metadata) and
    // join every buffered text in arrival order into one intent.
    const base = buf[buf.length - 1].msg;
    const coalescedText = buf.map(i => i.text).filter(Boolean).join('\n');
    const msg = { ...base, text: coalescedText };

    // ШАГ 1.2 — cheap completeness gate. Only nudge when the thought looks
    // clearly cut off, and only ONCE per buffer: if we've already nudged, we
    // dispatch regardless (bias to pass — never trap the user in a nag loop).
    const alreadyNudged = (await this.state.storage.get('nudged')) === true;
    if (!alreadyNudged) {
      const { complete } = await checkCompleteness(this.env, { text: coalescedText });
      if (!complete) {
        // Keep the buffer, remember we nudged, and give the user room to finish.
        await this.state.storage.put('nudged', true);
        await this.state.storage.setAlarm(Date.now() + SOFT_REARM_MS);
        const chatId = base.chat?.id;
        if (chatId) {
          await sendMessage(
            this.env.BOT_TOKEN,
            chatId,
            'Похоже, мысль не закончена — допишите следующим сообщением, и я возьмусь.',
          );
        }
        return;
      }
    }

    // Dispatch. Consume the buffer and gate flag first so a crash before we set
    // busy can't double-fire the same thought; then mark the chat busy so any
    // messages arriving during the run are held (ШАГ 1.3) rather than dispatched.
    await this.state.storage.delete('buf');
    await this.state.storage.delete('nudged');
    await this.state.storage.put('busy', true);
    await this.state.storage.put('busySince', Date.now());
    // Safety net: if this run never returns (isolate eviction), this alarm frees
    // the hold. A normal completion replaces it in finally, so it only ever fires
    // on a genuinely dead run.
    await this.state.storage.setAlarm(Date.now() + BUSY_MAX_MS);

    try {
      // Dynamic import avoids a circular import at module load (message.js is the
      // normal request path; the DO is only reached via the binding).
      const { handleMessage } = await import('./handlers/message.js');
      await handleMessage(msg, this.env);
    } finally {
      // Release the hold. Whatever piled up while we were busy gets flushed as one
      // coalesced message after a short debounce (POST_RUN_MS) so a trailing edit
      // sent right as the run finishes still lands in the same batch.
      await this.state.storage.delete('busy');
      await this.state.storage.delete('busySince');
      const remaining = (await this.state.storage.get('buf')) || [];
      if (remaining.length) {
        await this.state.storage.setAlarm(Date.now() + POST_RUN_MS);
      } else {
        await this.state.storage.deleteAlarm();
      }
    }
  }
}

function json(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { 'content-type': 'application/json' },
  });
}
