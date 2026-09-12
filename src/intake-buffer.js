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

const DEBOUNCE_MS = 10_000; // silence window before flush; tune via ШАГ 1 acceptance

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
    await this.state.storage.delete('buf');
    if (!buf.length) return;

    // Coalesce: reuse the last message envelope (chat/from/reply metadata) and
    // join every buffered text in arrival order into one intent.
    const base = buf[buf.length - 1].msg;
    const coalescedText = buf.map(i => i.text).filter(Boolean).join('\n');
    const msg = { ...base, text: coalescedText };

    // TODO ШАГ 1.2: run the cheap completeness gate here before dispatching.
    // If the coalesced text still looks like a cut-off thought, re-arm a short
    // alarm and send a soft "похоже, мысль не закончена — дополните?" instead of
    // dispatching. Bias strongly toward dispatching (don't nag on normal input).

    // Dynamic import avoids a circular import at module load (message.js is the
    // normal request path; the DO is only reached via the binding).
    const { handleMessage } = await import('./handlers/message.js');
    await handleMessage(msg, this.env);
  }
}
