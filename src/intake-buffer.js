// Durable Object: per-chat intake debounce buffer.
//
// Problem it solves: a user who is still typing / accidentally sends early /
// wants to append to the previous line triggers an expensive Claude session on a
// half-finished thought, which then re-does the work when the missing argument
// arrives. This DO coalesces rapid-fire messages from one chat into a single
// agent run, fired only after DEBOUNCE_MS of silence.
//
// One instance per chat_id (idFromName(chatId)). Each incoming plain-text message
// appends to the buffer and (re)arms the alarm; the alarm resets on every new
// message, so the run happens only once the user has stopped typing.

import { sendMessage } from './lib/telegram.js';
import { checkCompleteness } from './lib/agent-client.js';

const DEBOUNCE_MS = 10_000;      // silence window before flush; tune via ШАГ 1 acceptance
const SOFT_REARM_MS = 15_000;    // grace window after a "looks unfinished" nudge

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
      // (Re)arm the alarm — every new message pushes the flush further out,
      // giving the user room to finish / correct / append.
      await this.state.storage.setAlarm(Date.now() + DEBOUNCE_MS);
      return new Response(JSON.stringify({ buffered: buf.length }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  }

  async alarm() {
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

    // Dispatch: clear state first so a crash can't double-fire the same buffer.
    await this.state.storage.delete('buf');
    await this.state.storage.delete('nudged');

    // Dynamic import avoids a circular import at module load (message.js is the
    // normal request path; the DO is only reached via the binding).
    const { handleMessage } = await import('./handlers/message.js');
    await handleMessage(msg, this.env);
  }
}
