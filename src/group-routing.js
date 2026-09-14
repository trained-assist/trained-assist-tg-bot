// Pure group-message trigger decisions for the gateway.
//
// Extracted from index.js's dispatchInner so the "does the bot react in a group?"
// rule is unit-testable and can't silently drift again (it had ZERO tests and had
// grown a voice/audio special-case that leaked into large groups — see
// docs/GROUP-TRIGGER-MATRIX.md). No IO here: index.js resolves session/memberCount
// and feeds them in.

/** True if the bot is @-mentioned in the message text OR caption (case-insensitive). */
export function isBotMention(msg, botUsername) {
  const u = (botUsername || '').toLowerCase();
  if (!u) return false;
  const hay = `${msg?.text || ''}\n${msg?.caption || ''}`.toLowerCase();
  return hay.includes(`@${u}`);
}

/** True if this message is a reply to one of the bot's own messages (case-insensitive). */
export function isReplyToBot(msg, botUsername) {
  const u = (botUsername || '').toLowerCase();
  const from = msg?.reply_to_message?.from?.username;
  return !!u && !!from && from.toLowerCase() === u;
}

/** Addressed = the user is deliberately talking TO the bot (mention or reply). */
export function isAddressedToBot(msg, botUsername) {
  return isBotMention(msg, botUsername) || isReplyToBot(msg, botUsername);
}

/** Remove every @botusername token from text, case-insensitive. */
export function stripBotMention(text, botUsername) {
  const u = (botUsername || '').trim();
  if (!text || !u) return (text || '').trim();
  const esc = u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`@${esc}`, 'gi'), '').replace(/\s{2,}/g, ' ').trim();
}

/** Does this message carry anything the bot could act on? */
export function hasContent(msg) {
  return !!(msg?.voice || msg?.audio || msg?.document || msg?.photo || msg?.text);
}

/**
 * Should the bot react to an AMBIENT group message — one that is neither a command
 * nor addressed to the bot? Applies uniformly to text AND voice/audio (removing the
 * old voice-only bypass that made the bot answer audio in large groups, bug #4).
 *
 *   • allMsgMode ON            → yes (explicit "react to everything")
 *   • memberCount <= 2         → yes (bot + 1 human = a de-facto 1-on-1)
 *   • otherwise (big group)    → no
 *
 * memberCount is expected to be a real number; an unknown count (undefined/null)
 * is treated as "big" so a lookup failure fails closed (bot stays quiet), matching
 * the getGroupMemberCount 999 fail-safe.
 */
export function shouldHandleAmbient({ allMsgMode, memberCount } = {}) {
  if (allMsgMode) return true;
  return typeof memberCount === 'number' && memberCount <= 2;
}

/**
 * Full disposition for a non-admin group message. Pure. `memberCount` may be omitted
 * when it hasn't been (and needn't be) fetched — it's only consulted for ambient
 * messages with all-messages mode off.
 *
 * Returns one of:
 *   { action: 'command',  cleanText }   — a slash command
 *   { action: 'answer',   cleanText }   — addressed to bot → answer now (bypass buffer)
 *   { action: 'accumulate', cleanText } — ambient, small group / all-msg → intake buffer
 *   { action: 'ignore' }                — ambient in a big group, or empty message
 */
export function groupDisposition(msg, { botUsername, allMsgMode, memberCount } = {}) {
  const text = msg?.text || '';
  const cleanText = stripBotMention(text, botUsername);

  if (text.startsWith('/')) return { action: 'command', cleanText };
  if (isAddressedToBot(msg, botUsername)) return { action: 'answer', cleanText };
  if (!hasContent(msg)) return { action: 'ignore' };
  if (shouldHandleAmbient({ allMsgMode, memberCount })) return { action: 'accumulate', cleanText };
  return { action: 'ignore' };
}
