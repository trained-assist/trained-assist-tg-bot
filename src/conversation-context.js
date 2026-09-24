export function validThreadId(threadId) {
  return Number.isInteger(threadId) && threadId > 0;
}

export function conversationKey(chatId, threadId) {
  return validThreadId(threadId) ? `${chatId}:${threadId}` : String(chatId);
}

export function deliveryContext(message = {}, audience = undefined) {
  return {
    ...(audience === undefined ? {} : { audience }),
    chatId: message.chat?.id ?? message.chatId ?? message.chat_id,
    ...(validThreadId(message.message_thread_id ?? message.threadId)
      ? { threadId: message.message_thread_id ?? message.threadId }
      : {}),
  };
}

export function threadExtra(threadId) {
  return validThreadId(threadId) ? { message_thread_id: threadId } : {};
}
