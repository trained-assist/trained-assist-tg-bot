import { getSession, setSession } from '../lib/kv.js';
import { sendMessage } from '../lib/telegram.js';
import { answerCallbackQuery } from '../lib/telegram.js';

export async function handleCallbackQuery(cq, env) {
  const { id, data, message, from } = cq;
  const chatId = message?.chat?.id || from?.id;

  if (!chatId) {
    await answerCallbackQuery(env.BOT_TOKEN, id);
    return;
  }

  // Session selection: s:<sessionId> or s:new
  if (data?.startsWith('s:')) {
    const sessionId = data.slice(2);
    const session = await getSession(env.SESSIONS, chatId);
    if (!session) {
      await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Сначала войди: /login');
      return;
    }

    if (sessionId === 'new') {
      await setSession(env.SESSIONS, chatId, { ...session, activeSessionId: null });
      await answerCallbackQuery(env.BOT_TOKEN, id, '✨ Начат новый диалог');
      await sendMessage(env.BOT_TOKEN, chatId,
        '✨ <b>Новый диалог</b>\n\nПиши задачу — начну с чистого листа.'
      );
    } else {
      await setSession(env.SESSIONS, chatId, { ...session, activeSessionId: sessionId });
      await answerCallbackQuery(env.BOT_TOKEN, id, '📌 Диалог выбран');
      await sendMessage(env.BOT_TOKEN, chatId,
        '📌 <b>Продолжаю этот диалог</b>\n\nПиши следующее сообщение — отвечу с учётом предыдущего контекста.'
      );
    }
    return;
  }

  await answerCallbackQuery(env.BOT_TOKEN, id);
}
