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
//             The hold is driven by POLLING the agent's live task state
//             (/tasks/running), NOT by the /run dispatch call: /run returns 202 on
//             enqueue and Claude runs in the background for minutes, so awaiting the
//             dispatch tells us nothing about the session's real duration. Polling
//             reads ground truth and self-heals — a missed poll (isolate eviction)
//             just retries on the next durable alarm; a lost callback can't trap the
//             buffer. BUSY_MAX_MS is the ultimate backstop.
//
// One instance per chat_id (idFromName(chatId)). Durable Object alarm handlers are
// serialised per instance, so a poll can never race a live dispatch.

import { sendMessage } from './lib/telegram.js';
import { checkCompleteness, isTaskRunning } from './lib/agent-client.js';

const DEBOUNCE_MS = 10_000;      // silence window before flush; tune via ШАГ 1 acceptance
const SOFT_REARM_MS = 15_000;    // grace window after a "looks unfinished" nudge
const POST_RUN_MS = 4_000;       // short debounce after a run frees up, to catch a trailing edit
const POLL_MS = 12_000;          // cadence for polling the agent's live task state during a hold
const START_GRACE_MS = 30_000;   // enqueue→spawn grace: /run is 202, the claude proc may not be
                                 // visible in the agent's task registry for a few seconds (queue/
                                 // semaphore). Until we've seen it running once, don't treat
                                 // "not running" as done inside this window.
const BUSY_MAX_MS = 45 * 60_000; // safety: if a run never signals done (agent unreachable, isolate
                                 // evicted mid-flight), release the hold after this so the buffer
                                 // can't be trapped forever. Must exceed the longest legitimate
                                 // session (~40 min agent cap).

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
        // alarm. The poll alarm (re-armed by the busy branch of alarm()) is the
        // only timer; the buffer will be flushed once polling observes the run
        // has finished, not by a debounce.
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
    // While a hold is in force, every alarm is a poll tick — check the agent's
    // live task state and either keep holding or release + schedule the flush.
    const busy = (await this.state.storage.get('busy')) === true;
    if (busy) {
      return await this.pollBusy();
    }
    // Idle: this is a debounce / post-run flush. Coalesce and dispatch.
    return await this.flush();
  }

  // Poll tick during a busy-hold. Serialised with everything else on this DO.
  async pollBusy() {
    const now = Date.now();
    const since = (await this.state.storage.get('busySince')) || 0;
    const elapsed = now - since;

    // Ultimate backstop: a run that never signals done (agent down the whole time,
    // or isolate died mid-flight). Release so the buffer isn't trapped forever.
    if (elapsed >= BUSY_MAX_MS) {
      await this.releaseBusy();
      return await this.afterRelease();
    }

    const pollUser = await this.state.storage.get('pollUser');
    if (!pollUser) {
      // No username to poll against (dispatch didn't start a run). Nothing to
      // hold for — release and flush whatever arrived.
      await this.releaseBusy();
      return await this.afterRelease();
    }

    const { running } = await isTaskRunning(this.env, { username: pollUser });
    if (running) {
      // Session live — remember we saw it start, keep holding, poll again later.
      await this.state.storage.put('seenRunning', true);
      await this.state.storage.setAlarm(now + POLL_MS);
      return;
    }

    // Agent reports no live task for this user.
    const seen = (await this.state.storage.get('seenRunning')) === true;
    if (!seen && elapsed < START_GRACE_MS) {
      // Enqueued but the claude proc hasn't appeared in the registry yet
      // (queue/semaphore). Don't mistake "not spawned yet" for "finished".
      await this.state.storage.setAlarm(now + POLL_MS);
      return;
    }

    // Session finished (or never started within the grace window). Release the
    // hold and let a short post-run debounce catch a trailing edit.
    await this.releaseBusy();
    return await this.afterRelease();
  }

  async releaseBusy() {
    await this.state.storage.delete('busy');
    await this.state.storage.delete('busySince');
    await this.state.storage.delete('seenRunning');
    await this.state.storage.delete('pollUser');
  }

  // Called right after a hold is released: whatever piled up during the run gets
  // flushed as one coalesced message after a short debounce (POST_RUN_MS) so a
  // trailing edit sent right as the run finishes still lands in the same batch.
  async afterRelease() {
    const remaining = (await this.state.storage.get('buf')) || [];
    if (remaining.length) {
      await this.state.storage.setAlarm(Date.now() + POST_RUN_MS);
    } else {
      await this.state.storage.deleteAlarm();
    }
  }

  async flush() {
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
    // Begin polling the agent for this run's real completion. Note: handleMessage
    // returns as soon as the agent /run enqueue responds (202) — it does NOT wait
    // for the session, so the hold cannot be released here.
    await this.state.storage.setAlarm(Date.now() + POLL_MS);

    let result = null;
    try {
      // Dynamic import avoids a circular import at module load (message.js is the
      // normal request path; the DO is only reached via the binding).
      const { handleMessage } = await import('./handlers/message.js');
      result = await handleMessage(msg, this.env);
    } catch (err) {
      // The enqueue itself failed unexpectedly. Don't trap the buffer — release
      // and flush anything that arrived so the next message re-arms cleanly.
      await this.releaseBusy();
      return await this.afterRelease();
    }

    if (result?.dispatched && result.username) {
      // Real run started — record who to poll. The poll alarm is already armed.
      await this.state.storage.put('pollUser', result.username);
      return;
    }

    // No run actually started (session picker, login prompt, handled-inline, or a
    // caught error already surfaced to the user). Nothing to hold for.
    await this.releaseBusy();
    return await this.afterRelease();
  }
}

function json(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { 'content-type': 'application/json' },
  });
}
