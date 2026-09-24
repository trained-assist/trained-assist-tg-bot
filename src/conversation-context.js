export function validThreadId(threadId) {
  return Number.isInteger(threadId) && threadId > 0;
}

export function conversationKey(chatId, threadId) {
  return validThreadId(threadId) ? `${chatId}:${threadId}` : String(chatId);
}

/** Extract a valid Telegram forum-topic id from a message-like object.
 *  Returns null (NOT 0/NaN) when absent — the hard guard: callers must treat
 *  null exactly like today's chat-only behavior. */
export function threadIdOf(message = {}) {
  const t = message?.message_thread_id ?? message?.threadId;
  return validThreadId(t) ? t : null;
}

export function deliveryContext(message = {}, audience = undefined) {
  const threadId = threadIdOf(message);
  return {
    ...(audience === undefined ? {} : { audience }),
    chatId: message.chat?.id ?? message.chatId ?? message.chat_id,
    ...(threadId == null ? {} : { threadId }),
  };
}

export function threadExtra(threadId) {
  return validThreadId(threadId) ? { message_thread_id: threadId } : {};
}
