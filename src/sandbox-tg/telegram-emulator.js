// CI emulator of the Telegram Bot API — the "Telegram-equivalent fixture" of
// card P11 (AC-101: CI fixture first, then a separate real test bot).
//
// What it emulates (and nothing more):
//  - bot identity (getMe) — the slice proves it talks to the TEST bot, never to
//    a production identity;
//  - inbound updates: the test harness pushes updates, the emulator delivers them
//    to the slice's webhook exactly like Telegram would (POST + secret token);
//  - outbound calls: sendMessage / sendDocument / editMessageReplyMarkup /
//    deleteMessage / setWebhook are recorded, so a test can assert WHAT was
//    delivered, WHERE (chat + bot) and HOW MANY TIMES (dedup/replay);
//  - delivery receipts: every webhook delivery is logged with its HTTP status —
//    the evidence for "durable ACK + replay" (AC-106 / PR-14);
//  - controlled failures: 429 with retry_after, 5xx, a dropped connection and a
//    re-delivery of the same update_id (duplicate webhook) — the failure modes
//    the live API cannot be asked to produce on demand.
//
// The emulator is transport-agnostic: `fetch` is a plain handler, so tests use
// it in-process and the e2e harness wraps it in a node http server.
//
// `Buffer` must be imported explicitly: Cloudflare Workers never expose it as an
// ambient global (only via `import … from 'node:buffer'`), so a bare `Buffer.`
// here would crash at photo-upload time under nodejs_compat. Guarded by
// tests/no-bare-buffer.test.js.
import { Buffer } from 'node:buffer';

export class TelegramEmulator {
  constructor(options = {}) {
    this.bot = {
      id: options.botId ?? 700000001,
      is_bot: true,
      username: options.botUsername ?? 'probability_cat_bot',
      first_name: options.botFirstName ?? 'Probability Cat (sandbox)',
    };
    this.updates = [];
    this.nextUpdateId = 1;
    this.messages = [];
    this.nextMessageId = 1;
    this.webhook = null;
    this.webhookDeliveries = [];
    this.faults = [];
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => Date.now());
  }

  // ------------------------------------------------------------- fixture API

  /** Queue an inbound update (message / callback_query) and return it. */
  pushUpdate(update) {
    const full = { update_id: this.nextUpdateId, ...update };
    this.nextUpdateId += 1;
    this.updates.push(full);
    return full;
  }

  pushMessage({ chatId, from = { id: 1001, is_bot: false, first_name: 'Sandbox', username: 'sandbox_user' }, text = null, messageId = null, messageThreadId = null, voice = null, document = null, date = null }) {
    const message = {
      message_id: messageId ?? this.nextMessageId,
      from,
      chat: { id: chatId, type: chatId < 0 ? 'group' : 'private', title: chatId < 0 ? 'Sandbox group' : null },
      date: date ?? Math.floor(this.now() / 1000),
    };
    if (messageThreadId != null) message.message_thread_id = messageThreadId;
    if (text != null) message.text = text;
    if (voice != null) message.voice = voice;
    if (document != null) message.document = document;
    this.nextMessageId = Math.max(this.nextMessageId, message.message_id + 1);
    return this.pushUpdate({ message });
  }

  /** Inject a failure into the next outbound call (or webhook delivery). */
  failNext({ scope = 'send', status = 500, code = 'INTERNAL', description = 'injected failure', retryAfterSec = null, drop = false }) {
    this.faults.push({ scope, status, code, description, retryAfterSec, drop });
  }

  /** Re-deliver an already delivered update (Telegram retries after a timeout). */
  redeliver(updateId) {
    const update = this.updates.find(item => item.update_id === updateId);
    if (!update) throw new Error(`update ${updateId} unknown to the emulator`);
    return update;
  }

  // -------------------------------------------------------------- Bot API

  /** Deliver one update to the slice's webhook, like Telegram would. */
  async deliverUpdate(update, { secretToken = null } = {}) {
    const target = this.webhook?.url;
    if (!target) throw new Error('no webhook registered');
    const headers = { 'content-type': 'application/json' };
    if (this.webhook.secretToken) headers['x-telegram-bot-api-secret-token'] = this.webhook.secretToken;
    const fault = this.faults.find(item => item.scope === 'webhook');
    const attempt = {
      updateId: update.update_id,
      at: this.now(),
      status: null,
      fault: fault ? { ...fault, drop: undefined } : null,
    };
    this.webhookDeliveries.push(attempt);
    if (fault) this.faults.splice(this.faults.indexOf(fault), 1);
    if (fault?.drop) {
      attempt.status = 0;
      throw new TypeError('fetch failed: webhook delivery dropped (injected)');
    }
    let res;
    try {
      res = await this.fetchImpl(target, {
        method: 'POST',
        headers,
        body: JSON.stringify(update),
      });
    } catch (e) {
      attempt.status = 0;
      throw e;
    }
    attempt.status = res.status;
    const text = await res.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    return { status: res.status, value: payload, attempt };
  }

  /** The Bot API surface the slice consumes. */
  async fetch(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const parts = url.pathname.split('/').filter(Boolean);
    let method;
    if (parts[0] === 'bot' && parts.length >= 3) {
      method = parts.slice(2).join('/');
    } else if (parts[0]?.startsWith('bot') && parts.length >= 2) {
      method = parts.slice(1).join('/');
    } else {
      return json({ ok: false, error_code: 404, description: 'not found' }, 404);
    }
    const body = await readJsonBody(input, init);
    const fault = this.faults.find(item => item.scope === 'send');
    if (fault) this.faults.splice(this.faults.indexOf(fault), 1);
    if (fault) {
      if (fault.drop) throw new TypeError('fetch failed: outbound call dropped (injected)');
      return json(
        { ok: false, error_code: fault.status, description: fault.description, parameters: fault.retryAfterSec != null ? { retry_after: fault.retryAfterSec } : undefined },
        fault.status,
      );
    }
    if (method === 'getMe') return json({ ok: true, result: { ...this.bot } });
    if (method === 'setWebhook') {
      this.webhook = { url: body.url, secretToken: body.secret_token ?? null };
      return json({ ok: true, result: true, description: 'webhook set' });
    }
    if (method === 'sendMessage') {
      const message = {
        message_id: this.nextMessageId++,
        from: { ...this.bot },
        chat: { id: body.chat_id, type: body.chat_id < 0 ? 'group' : 'private' },
        date: Math.floor(this.now() / 1000),
        text: body.text ?? null,
        reply_to_message_id: body.reply_to_message_id ?? null,
      };
      this.messages.push({ method, message, request: body });
      return json({ ok: true, result: message });
    }
    if (method === 'sendDocument') {
      const message = {
        message_id: this.nextMessageId++,
        from: { ...this.bot },
        chat: { id: body.chat_id, type: body.chat_id < 0 ? 'group' : 'private' },
        date: Math.floor(this.now() / 1000),
        document: { file_name: body.filename ?? 'file', file_size: body.size ?? null },
        caption: body.caption ?? null,
      };
      this.messages.push({ method, message, request: body });
      return json({ ok: true, result: message });
    }
    if (method === 'editMessageReplyMarkup') {
      const existing = this.messages.find(item => item.message.message_id === body.message_id);
      if (existing) existing.message.reply_markup = body.reply_markup ?? null;
      return json({ ok: true, result: true });
    }
    if (method === 'deleteMessage') {
      const index = this.messages.findIndex(item => item.message.message_id === body.message_id);
      if (index >= 0) this.messages.splice(index, 1);
      return json({ ok: true, result: true });
    }
    return json({ ok: false, error_code: 404, description: `unknown method ${method}` }, 404);
  }

  // ------------------------------------------------------------------ reads

  messagesTo(chatId) {
    return this.messages.filter(item => item.message.chat.id === chatId);
  }

  outboundCalls(method) {
    return this.messages.filter(item => item.method === method);
  }
}

async function readJsonBody(input, init) {
  if (init?.body == null) return {};
  if (typeof init.body === 'string') {
    try {
      return JSON.parse(init.body);
    } catch {
      return {};
    }
  }
  if (init.body instanceof FormData) {
    const out = {};
    for (const [key, value] of init.body.entries()) {
      out[key] = value instanceof Blob ? { filename: value.name, size: value.size } : value;
    }
    return out;
  }
  return {};
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Node http server around the emulator — for the live e2e harness. */
export function createEmulatorServer(emulator, { port = 0, host = '127.0.0.1' } = {}) {
  const { createServer } = require('node:http');
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) headers[key] = value;
    try {
      const response = await emulator.fetch(`http://${host}${req.url}`, {
        method: req.method,
        headers,
        body: body || undefined,
      });
      const text = await response.text();
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json' });
      res.end(text);
    } catch (e) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error_code: 502, description: String(e?.message ?? e) }));
    }
  });
  return new Promise(resolve => {
    server.listen(port, host, () => resolve({ server, port: server.address().port, url: `http://${host}:${server.address().port}` }));
  });
}

export default TelegramEmulator;