// Only disposable navigation/picker messages belong here. Results, intake
// collectors, login replies and URL buttons are never deleted by this policy.
export const PICKER_TTL_MS = 10 * 60 * 1000;
export const MENU_TTL_MS = 15 * 60 * 1000;
export function uiLifetime(data) {
  if (/^(pp|sp):/.test(data || '')) return PICKER_TTL_MS;
  if (/^(sd|sc|si|sn|sl|nd|ar|sa|fl|fr):/.test(data || '')) return MENU_TTL_MS;
  return null;
}
function prefix(env) { return `ui-expiry:${String(env.BOT_TOKEN).split(':')[0]}:`; }
function key(env, chatId, messageId) { return `${prefix(env)}${chatId}:${messageId}`; }

export async function trackUI(env, chatId, messageId, keyboard, createdAt = Date.now()) {
  if (!env?.SESSIONS || !messageId) return;
  const buttons = (keyboard || []).flat();
  const lifetimes = buttons.map(b => uiLifetime(b.callback_data));
  if (!buttons.length || lifetimes.some(t => !t)) return;
  await env.SESSIONS.put(key(env, chatId, messageId), JSON.stringify({
    chatId, messageId, dueAt: createdAt + Math.min(...lifetimes),
  }), { expirationTtl: 48 * 60 * 60 });
}
export async function forgetUI(env, chatId, messageId) {
  if (env?.SESSIONS) await env.SESSIONS.delete(key(env, chatId, messageId));
}
async function telegram(env, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return res.json();
}
export async function retireUI(env, chatId, messageId) {
  const body = { chat_id: chatId, message_id: messageId };
  const deleted = await telegram(env, 'deleteMessage', body);
  if (deleted.ok || /message to delete not found/i.test(deleted.description || '')) return true;
  // Telegram may disallow deletion (old messages/permissions). At least remove
  // the dead controls. Retry transient failures on the next cron invocation.
  const edited = await telegram(env, 'editMessageReplyMarkup', {
    ...body, reply_markup: { inline_keyboard: [] },
  });
  return !!edited.ok || /message is not modified|message to edit not found/i.test(edited.description || '');
}
export async function processExpiredUI(env, now = Date.now()) {
  let cursor;
  do {
    const page = await env.SESSIONS.list({ prefix: prefix(env), ...(cursor ? { cursor } : {}) });
    for (const entry of page.keys) {
      try {
        const record = await env.SESSIONS.get(entry.name, { type: 'json' });
        if (!record || record.dueAt > now) continue;
        if (await retireUI(env, record.chatId, record.messageId)) await env.SESSIONS.delete(entry.name);
      } catch (err) { console.error('[ui-expiry] cleanup failed:', err.message); }
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
}

// Also covers old menus that predate the queue. Never execute a stale callback
// against a newer pending task, even if scheduled cleanup is late.
export async function rejectExpiredUI(cq, env, session) {
  const ttl = uiLifetime(cq.data);
  if (!ttl || !cq.message?.message_id) return false;
  const picker = /^(pp|sp):/.test(cq.data);
  const expired = cq.message.date && Date.now() >= cq.message.date * 1000 + ttl;
  const superseded = picker && session?.pendingPickerId && session.pendingPickerId !== cq.message.message_id;
  const missing = picker && (!session?.pendingMessage || !session.pendingMessageAt || Date.now() >= session.pendingMessageAt + PICKER_TTL_MS);
  if (!expired && !superseded && !missing) return false;
  await telegram(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: '⌛ Меню устарело. Открой его заново или отправь задачу.' });
  if (await retireUI(env, cq.message.chat.id, cq.message.message_id)) await forgetUI(env, cq.message.chat.id, cq.message.message_id);
  return true;
}
