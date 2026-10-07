// Profile mapping of the Telegram sandbox slice: an inbound update becomes a
// profile + destination, and nothing else.
//
// Rules:
//  - normal slices fail closed for chats not explicitly allowed. The isolated
//    UX login sandbox can opt into open chat ingress after profile login; its
//    Worker still pins all execution to the configured sandbox profile.
//  - the profile comes from the control-plane profile of the slice, optionally
//    overridden per chat (TG_SLICE_CHAT_PROFILES) — the mapping is data, not code;
//  - the destination is the chat (+ thread) the answer must go back to, and the
//    requesting bot identity is recorded so delivery can prove it answers the
//    chat and the bot that was asked (U-09 / PR-11);
//  - the ingress ref is deterministic: tg:<bot>:<chat>[:<thread>]:<messageId>.
//    It is the correlation key of the whole slice and the first field of every
//    log line (SANDBOX · I03: ingress ref, profile/channel/destination).

import { chatAllowed } from './config.js';

export const CHANNEL = 'telegram';

export function conversationIdOf(chatId, threadId = null) {
  return threadId == null ? `tg-${chatId}` : `tg-${chatId}-t${threadId}`;
}

export function ingressRefOf(botUsername, chatId, messageId, threadId = null) {
  const scope = threadId == null ? String(chatId) : `${chatId}:${threadId}`;
  return `tg:${botUsername}:${scope}:${messageId}`;
}

/**
 * Map an inbound update to a profile. Returns null when the chat is not allowed
 * — the caller then refuses the update (401/403) without touching the plane.
 */
export function profileForUpdate(config, update) {
  const message = extractMessage(update);
  if (!message) return null;
  const chatId = message.chat?.id;
  if (chatId == null) return null;
  const chatKey = String(chatId);
  if (!chatAllowed(config, chatKey)) return null;
  const threadId = message.message_thread_id ?? null;
  return {
    profileId: config.chatProfiles[chatKey] ?? config.profileId,
    principalId: config.principalId,
    sessionId: config.sessionId,
    channel: CHANNEL,
    destination: { chatId, threadId },
    requestingBot: config.botUsername,
    conversationId: conversationIdOf(chatId, threadId),
    ingressRef: ingressRefOf(config.botUsername, chatId, message.message_id, threadId),
    from: message.from ?? null,
    chatType: message.chat?.type ?? null,
  };
}

/** The message of an update, whatever carried it (message / channel_post / edited). */
export function extractMessage(update) {
  if (!update || typeof update !== 'object') return null;
  return update.message ?? update.channel_post ?? update.edited_message ?? update.callback_query?.message ?? null;
}

/** Callback query (inline keyboard) — the launch button of a batch. */
export function extractCallbackQuery(update) {
  return update && typeof update === 'object' ? update.callback_query ?? null : null;
}

export default { profileForUpdate, conversationIdOf, ingressRefOf, extractMessage, extractCallbackQuery, CHANNEL };
