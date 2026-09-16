import { answerCallbackQuery, editMessage } from './telegram.js';

// Route is fixed by the issuing VM; never infer it from a later profile/project
// selection or from task text. No fallback to another VM on timeout.
export async function handleRestartConfirmation(cq, env, session) {
  const match = /^ri:([mr]):([yn]):([0-9a-f-]{36})$/.exec(cq.data || '');
  if (!match || !session?.username || !cq.from?.id || !cq.message?.chat?.id) {
    await answerCallbackQuery(env.BOT_TOKEN, cq.id, 'Подтверждение недоступно. Войдите в исходный профиль.');
    return;
  }
  const url = match[1] === 'r' ? env.AGENT_RU_URL : env.AGENT_URL;
  if (!url) {
    await answerCallbackQuery(env.BOT_TOKEN, cq.id, 'Сервер задачи недоступен. Попробуйте позже.');
    return;
  }
  try {
    const response = await fetch(`${url}/restart/decision`, {
      method: 'POST', headers: { Authorization: `Bearer ${env.AGENT_SECRET}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({ handle: match[3], action: match[2] === 'y' ? 'confirm' : 'cancel',
        username: session.username, telegramUserId: cq.from.id, chatId: cq.message.chat.id,
        threadId: cq.message.message_thread_id ?? null }),
    });
    if (!response.ok) throw Error('Confirmation unavailable');
    const result = await response.json();
    if (!['confirm', 'cancel'].includes(result.decision)) throw Error('Stale confirmation');
    const text = result.decision === 'cancel' ? 'Задача отменена.' : 'Подтверждение сохранено. Задача ожидает запуска.';
    await answerCallbackQuery(env.BOT_TOKEN, cq.id, text);
    // Keep title/context in the original notification. Retry after lost ACK gets
    // the stored decision, so it cannot accidentally display the opposite action.
    await editMessage(env.BOT_TOKEN, cq.message.chat.id, cq.message.message_id,
      `${cq.message.text || 'Отложенная задача'}\n\n${text}`,
      { reply_markup: { inline_keyboard: [] } }).catch(() => {});
  } catch {
    await answerCallbackQuery(env.BOT_TOKEN, cq.id, 'Не удалось подтвердить. Проверьте исходный профиль или повторите позже.');
  }
}
