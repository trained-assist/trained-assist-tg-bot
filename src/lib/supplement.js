// «➕ Дополнить» (sup|{taskId}) — one-shot collector of the user's supplement to a
// running task. Scenario: agent docs/user-scenarios/core/02-stop-and-supplement.md
// SS-06/09/10.
//
// Why here and not in handleMessage: routeText sends every text/voice/file into the
// intake buffer BEFORE handleMessage runs, so the old KV draft check in message.js
// never saw the typed supplement in prod — it piled up as «Получил ещё N сообщений»
// and no confirmation ever appeared. Now the buffer's /ingest and /append divert
// the message into the draft themselves (no extra round-trip per message).
//
// State lives in the conversation's IntakeBuffer DO (/supplement), not SESSIONS KV:
// a burst (text + voice + file) must land in ONE draft, and only the DO is strongly
// consistent per conversation. Nothing runs on the typed text alone — the explicit
// supok| tap stops the task and restarts it; supno|, expiry and a command return the
// collected messages to the normal intake flow instead of dropping them.
import { conversationKey, threadExtra } from '../conversation-context.js';
import { sendMessageWithKeyboard, editMessage } from './telegram.js';

const stubFor = (env, chatId, threadId = null) =>
  env?.INTAKE?.get?.(env.INTAKE.idFromName(conversationKey(chatId, threadId)));

async function op(env, chatId, threadId, body) {
  const stub = stubFor(env, chatId, threadId);
  if (!stub) return null;
  const res = await stub.fetch('https://intake/supplement', { method: 'POST', body: JSON.stringify(body) });
  return res.ok ? res.json() : null;
}

export const supplementKeyboard = taskId => [[
  { text: '↩️ Вернуться', callback_data: `supno|${taskId}` },
  { text: '➕ Перезапуск с дополнением', callback_data: `supok|${taskId}` },
]];

export const confirmText = n =>
  `➕ Дополнение: ${n} ${n === 1 ? 'сообщение' : n < 5 ? 'сообщения' : 'сообщений'}. ` +
  'Остановить текущую задачу и перезапустить её с этим дополнением? Можно дописать ещё — войдёт в то же дополнение.';

/** sup| tap. Returns false when the chat has no intake DO (then nothing is armed). */
export async function armSupplement(env, chatId, threadId, { taskId, sessionId, expiresAt }) {
  const res = await op(env, chatId, threadId, { op: 'arm', taskId, sessionId, expiresAt });
  if (!res) return false;
  await releaseToIntake(env, chatId, threadId, res.released);
  return true;
}

/**
 * Debounce-off path only (INTAKE_DEBOUNCE=off): with the buffer on, /ingest and
 * /append divert the message themselves. true → became part of the supplement.
 */
export async function captureSupplement(env, msg, chatId, threadId) {
  let res;
  try {
    res = await op(env, chatId, threadId, { op: 'add', msg, now: Date.now() });
  } catch (e) {
    console.error('[supplement] add failed:', e.message);
    return false;
  }
  if (!res) return false;
  if (!res.armed) {
    await releaseToIntake(env, chatId, threadId, res.released);
    return false;
  }
  await showSupplementConfirm(env, msg, chatId, threadId, res);
  return true;
}

/** One confirmation bubble per draft, edited in place with the live message count. */
export async function showSupplementConfirm(env, msg, chatId, threadId, { taskId, count, confirmMsgId }) {
  const markup = { reply_markup: { inline_keyboard: supplementKeyboard(taskId) } };
  if (confirmMsgId) {
    await editMessage(env.BOT_TOKEN, chatId, confirmMsgId, confirmText(count), markup).catch(() => {});
    return;
  }
  // Only the first message sends the bubble; one that raced it before its id was
  // stored is folded in by the count re-check below — one bubble, not N.
  if (count !== 1) return;
  const sent = await sendMessageWithKeyboard(env.BOT_TOKEN, chatId, confirmText(1), supplementKeyboard(taskId),
    { reply_to_message_id: msg.message_id, allow_sending_without_reply: true, ...threadExtra(threadId) });
  const sentId = sent?.result?.message_id;
  if (!sentId) return;
  const after = await op(env, chatId, threadId, { op: 'confirm', msgId: sentId });
  if (after?.count > 1) await editMessage(env.BOT_TOKEN, chatId, sentId, confirmText(after.count), markup).catch(() => {});
}

/** supok|/supno| — atomically removes the draft so a double tap can't run it twice. */
export async function takeSupplement(env, chatId, threadId) {
  return (await op(env, chatId, threadId, { op: 'take' }))?.draft || null;
}

/** A command while armed cancels the draft (SS-09). Returns the dropped draft or null. */
export async function cancelSupplement(env, chatId, threadId) {
  if (!env?.INTAKE) return null;
  try {
    const peek = (await op(env, chatId, threadId, { op: 'peek' }))?.draft;
    if (!peek) return null;
    const draft = await takeSupplement(env, chatId, threadId);
    await releaseToIntake(env, chatId, threadId, draft?.items);
    return draft;
  } catch (e) {
    console.error('[supplement] cancel failed:', e.message);
    return null;
  }
}

/** Collected-but-unconfirmed messages go back to the ordinary intake flow (K5). */
export async function releaseToIntake(env, chatId, threadId, items = []) {
  const stub = items?.length ? stubFor(env, chatId, threadId) : null;
  if (!stub) return;
  const ingest = env.AGENT_URL && env.SESSIONS;
  for (const item of items) {
    await stub.fetch(ingest ? 'https://intake/ingest' : 'https://intake/append', {
      method: 'POST', body: JSON.stringify({ text: item.msg.text, msg: item.msg, flush: false }),
    }).catch(e => console.error('[supplement] release failed:', e.message));
  }
}
