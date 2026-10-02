// Bot API client of the slice. Talks to whatever base URL the environment says:
// the real api.telegram.org in a live smoke, the CI emulator in tests and e2e.
//
// The token is used ONLY to build the URL of the bot's own endpoints; it is
// never logged, never put into a query string and never returned in an error.

export class TelegramApiError extends Error {
  constructor(status, payload) {
    super(`telegram ${payload?.error_code ?? 'error'}: ${payload?.description ?? status}`);
    this.name = 'TelegramApiError';
    this.status = status;
    this.payload = payload ?? null;
    this.retryAfterSec = Number(payload?.parameters?.retry_after) || null;
  }

  get retryable() {
    return this.status === 429 || this.status >= 500;
  }
}

export class TelegramApi {
  constructor(config, options = {}) {
    this.baseUrl = config.telegramApiBase;
    this.token = options.token ?? config.botToken ?? '';
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 10000;
  }

  /** URL of one bot endpoint. The token is part of the path, never of the query. */
  botUrl(method) {
    return `${this.baseUrl}/bot${this.token}/${method}`;
  }

  async call(method, body = {}) {
    return this.post(method, JSON.stringify(body), { 'content-type': 'application/json' });
  }

  /** Multipart call (file upload): the boundary is set by the runtime, not by us. */
  async callForm(method, form) {
    return this.post(method, form, {});
  }

  async post(method, body, headers) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetchImpl(this.botUrl(method), {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { ok: false, error_code: res.status, description: text.slice(0, 200) };
    }
    if (!res.ok || payload?.ok !== true) {
      throw new TelegramApiError(res.status, payload);
    }
    return payload.result;
  }

  getMe() {
    return this.call('getMe');
  }

  setWebhook({ url, secretToken = null, allowedUpdates = ['message', 'callback_query'] } = {}) {
    return this.call('setWebhook', {
      url,
      secret_token: secretToken ?? undefined,
      allowed_updates: allowedUpdates,
    });
  }

  sendMessage({ chatId, text, replyToMessageId = null, replyMarkup = null, parseMode = null }) {
    return this.call('sendMessage', {
      chat_id: chatId,
      text,
      reply_to_message_id: replyToMessageId ?? undefined,
      reply_markup: replyMarkup ?? undefined,
      parse_mode: parseMode ?? undefined,
    });
  }

  sendDocument({ chatId, document, filename, caption = null, contentType = 'application/octet-stream', replyToMessageId = null }) {
    // Multipart is the only honest way to upload bytes; the emulator accepts it
    // exactly like the real API (field `document`, optional filename/caption).
    const form = new FormData();
    form.set('chat_id', String(chatId));
    form.set('document', new Blob([document], { type: contentType }), filename);
    if (caption != null) form.set('caption', caption);
    if (replyToMessageId != null) form.set('reply_to_message_id', String(replyToMessageId));
    return this.callForm('sendDocument', form);
  }

  editMessageReplyMarkup({ chatId, messageId, replyMarkup = null }) {
    return this.call('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup ?? undefined,
    });
  }

  deleteMessage({ chatId, messageId }) {
    return this.call('deleteMessage', { chat_id: ChatId, message_id: messageId });
  }
}

export default TelegramApi;