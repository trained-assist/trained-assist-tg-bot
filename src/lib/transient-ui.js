// Only disposable navigation/picker messages belong here. Results, intake
// collectors, login replies and URL buttons are never deleted by this policy.
export const PICKER_TTL_MS = 10 * 60 * 1000;
export const MENU_TTL_MS = 15 * 60 * 1000;
export function uiLifetime(data) {
  if (/^(pp|sp|pc):/.test(data || '')) return PICKER_TTL_MS;
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

// `session` comes from Workers KV, which gives no read-after-write guarantee across
// requests/colos — the write that stashes pending-picker state (from the message that
// showed the picker) and this read (from the callback tap moments later) are different
// requests and can land on different colos. A picker tapped quickly after being shown
// can then see a session that looks like the pending state was never written, even
// though nothing actually expired or was superseded. Trust that "looks empty" reading
// as real absence only once the picker is old enough that KV propagation has had time
// to catch up; a record that's genuinely present but stale/superseded/dispatching still
// rejects immediately, since none of that depends on a possibly-stale KV read resolving.
export const KV_PROPAGATION_GRACE_MS = 20_000;

function graceElapsed(cq) {
  return !cq.message.date || Date.now() >= cq.message.date * 1000 + KV_PROPAGATION_GRACE_MS;
}

// Shared by every handler that dispatches a stashed pendingMessage (sp:/pp: in
// callbacks.js) — one definition of "is it still usable" instead of each re-deriving
// it ad hoc, which is exactly how they'd drift out of sync with rejectExpiredUI's copy.
export function pendingMessageFresh(session) {
  const pending = session?.pendingMessage;
  return !!(pending && session.pendingMessageAt && (Date.now() - session.pendingMessageAt) < PICKER_TTL_MS);
}

// Shared by rejectExpiredUI (the top-level gate) and chooseProject's own guard
// (project-choice.js) — both need the identical answer to "is this pc: picker still
// good?", and having it written twice is exactly how the two drifted out of sync before.
export function projectChoiceExpired(pending, cq) {
  if (!pending) return graceElapsed(cq);
  if (pending.dispatching || pending.suspended) return true;
  if (Date.now() - pending.createdAt >= PICKER_TTL_MS) return true;
  if (pending.messageId == null) return graceElapsed(cq);
  return pending.messageId !== cq.message.message_id;
}

// Also covers old menus that predate the queue. Never execute a stale callback
// against a newer pending task, even if scheduled cleanup is late.
export async function rejectExpiredUI(cq, env, session) {
  const ttl = uiLifetime(cq.data);
  if (!ttl || !cq.message?.message_id) return false;
  const projectPicker = cq.data.startsWith('pc:');
  const picker = /^(pp|sp):/.test(cq.data);
  const expired = cq.message.date && Date.now() >= cq.message.date * 1000 + ttl;
  const superseded = picker && session?.pendingPickerId && session.pendingPickerId !== cq.message.message_id;
  const noPendingRecord = !session?.pendingMessage || !session.pendingMessageAt;
  const pendingExpired = session?.pendingMessageAt && Date.now() >= session.pendingMessageAt + PICKER_TTL_MS;
  const missing = picker && ((noPendingRecord && graceElapsed(cq)) || pendingExpired);
  const projectMissing = projectPicker && projectChoiceExpired(session?.pendingProjectChoice, cq);
  if (!expired && !superseded && !missing && !projectMissing) return false;
  await telegram(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: '⌛ Меню устарело. Открой его заново или отправь задачу.' });
  if (await retireUI(env, cq.message.chat.id, cq.message.message_id)) await forgetUI(env, cq.message.chat.id, cq.message.message_id);
  return true;
}
