import { getSession, setSession } from '../lib/kv.js';
import { sendMessage } from '../lib/telegram.js';
import { answerCallbackQuery } from '../lib/telegram.js';
import { runTask, readFile } from '../lib/agent-client.js';
import { cmdFiles } from './commands.js';

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

  // ── File browser: navigate into folder ───────────────────────────────────
  if (data?.startsWith('fl:')) {
    await answerCallbackQuery(env.BOT_TOKEN, id);
    const relPath = data.slice(3); // may be empty string = root
    await cmdFiles(chatId, env, relPath);
    return;
  }

  // ── File browser: read file ───────────────────────────────────────────────
  if (data?.startsWith('fr:')) {
    const relPath = data.slice(3);
    if (!session) { await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Войди: /login'); return; }
    await answerCallbackQuery(env.BOT_TOKEN, id);

    let fileData;
    try {
      fileData = await readFile(env, { username: session.username, path: relPath });
    } catch (e) {
      await sendMessage(env.BOT_TOKEN, chatId, `❌ Не удалось прочитать файл: ${e.message}`);
      return;
    }

    const { content, truncated, size } = fileData;
    const fileName = relPath.split('/').pop();
    const ext = fileName.split('.').pop().toLowerCase();

    // Pretty-print JSON
    let display = content;
    if (ext === 'json') {
      try { display = JSON.stringify(JSON.parse(content), null, 2); } catch {}
    }

    const header = `📄 <code>${relPath}</code>${truncated ? ` (первые 3.5кб из ${Math.round(size/1024)}кб)` : ''}`;
    const body = `<pre>${display.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>`;
    const fullMsg = `${header}\n\n${body}`;

    // Telegram message limit 4096 chars
    if (fullMsg.length <= 4096) {
      await sendMessage(env.BOT_TOKEN, chatId, fullMsg);
    } else {
      await sendMessage(env.BOT_TOKEN, chatId, header);
      await sendMessage(env.BOT_TOKEN, chatId, `<pre>${display.slice(0, 3800).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>`);
    }
    return;
  }

  await answerCallbackQuery(env.BOT_TOKEN, id);
}
