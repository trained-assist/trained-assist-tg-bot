import { getSession, setSession } from '../lib/kv.js';
import { sendMessage } from '../lib/telegram.js';
import { answerCallbackQuery } from '../lib/telegram.js';
import { runTask } from '../lib/agent-client.js';

export async function handleCallbackQuery(cq, env) {
  const { id, data, message, from } = cq;
  const chatId = message?.chat?.id || from?.id;

  if (!chatId) {
    await answerCallbackQuery(env.BOT_TOKEN, id);
    return;
  }

  const session = await getSession(env.SESSIONS, chatId);

  // ── Session picker (from message.js disambiguation) ──────────────────────
  // sp:<id> or sp:new — triggered when routing was ambiguous
  if (data?.startsWith('sp:')) {
    if (!session) {
      await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Сначала войди: /login');
      return;
    }

    const sessionId = data.slice(3);
    const pending = session.pendingMessage;

    if (!pending || !session.pendingMessageAt || (Date.now() - session.pendingMessageAt) > 10 * 60 * 1000) {
      await answerCallbackQuery(env.BOT_TOKEN, id, '⏱ Сообщение устарело — отправь снова');
      return;
    }

    const resolvedId = sessionId === 'new'
      ? `s-${chatId}-${Date.now()}`
      : sessionId;

    await answerCallbackQuery(env.BOT_TOKEN, id, '▶️ Запускаю…');

    // Update session state before running task
    await setSession(env.SESSIONS, chatId, {
      ...session,
      activeSessionId: sessionId === 'new' ? null : resolvedId,
      lastSessionId: resolvedId,
      lastMessageAt: Date.now(),
      pendingMessage: null,
      pendingMessageAt: null,
    });

    // Fire-and-forget — agent sends its own ⏳ Думаю…
    runTask(env, {
      userId: chatId,
      username: session.username,
      task: pending,
      context: null,
      sessionId: resolvedId,
    }).catch(err =>
      sendMessage(env.BOT_TOKEN, chatId, `❌ Ошибка: ${err.message}`)
    );
    return;
  }

  // ── Manual session switch (from /sessions list) ───────────────────────────
  // s:<id> or s:new — triggered from /sessions command
  if (data?.startsWith('s:')) {
    if (!session) {
      await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Сначала войди: /login');
      return;
    }

    const sessionId = data.slice(2);

    if (sessionId === 'new') {
      await setSession(env.SESSIONS, chatId, {
        ...session,
        activeSessionId: null,
        lastSessionId: null,
      });
      await answerCallbackQuery(env.BOT_TOKEN, id, '✨ Начат новый диалог');
      await sendMessage(env.BOT_TOKEN, chatId,
        '✨ <b>Новый диалог</b>\n\nПиши задачу — начну с чистого листа.'
      );
    } else {
      await setSession(env.SESSIONS, chatId, { ...session, activeSessionId: sessionId });
      await answerCallbackQuery(env.BOT_TOKEN, id, '📌 Диалог выбран');
      await sendMessage(env.BOT_TOKEN, chatId,
        '📌 <b>Продолжаю этот диалог</b>\n\nПиши следующее сообщение — отвечу с учётом контекста.'
      );
    }
    return;
  }

  await answerCallbackQuery(env.BOT_TOKEN, id);
}
