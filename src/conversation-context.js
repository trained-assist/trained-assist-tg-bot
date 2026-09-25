export function validThreadId(threadId) {
  return Number.isInteger(threadId) && threadId > 0;
}

export function conversationKey(chatId, threadId) {
  return validThreadId(threadId) ? `${chatId}:${threadId}` : String(chatId);
}

/** Telegram also sets message_thread_id on ordinary group replies. Only a
 * forum topic is a separate conversation; treating reply roots as topics sends
 * collector callbacks to empty Durable Objects. threadId is our trusted internal
 * context field, used by callers that have already resolved the Telegram message. */
export function threadIdOf(message = {}) {
  if (message?.message_thread_id != null) {
    if (message.is_topic_message !== true && message.chat?.is_forum !== true) return null;
    return validThreadId(message.message_thread_id) ? message.message_thread_id : null;
  }
  return validThreadId(message?.threadId) ? message.threadId : null;
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
