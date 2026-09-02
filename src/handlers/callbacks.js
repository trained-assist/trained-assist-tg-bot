import { getSession, setSession, deleteSession } from '../lib/kv.js';
import { sendMessage, sendMessageWithKeyboard, editMessage, pinChatMessage, unpinChatMessage } from '../lib/telegram.js';
import { answerCallbackQuery } from '../lib/telegram.js';
import { runTask, getSessions, readFile } from '../lib/agent-client.js';
import { cmdFiles, timeAgo } from './commands.js';

export async function handleCallbackQuery(cq, env) {
  const { id, data, message, from } = cq;
  const chatId = message?.chat?.id || from?.id;

  if (!chatId) return;

  const session = await getSession(env.SESSIONS, chatId);

  // ── Session picker (from message.js disambiguation) ──────────────────────
  // sp:<id> or sp:new — triggered when routing was ambiguous
  if (data?.startsWith('sp:')) {
    if (!session) { await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Войди: /login'); return; }

    const sessionId = data.slice(3);
    const pending = session.pendingMessage;
    const pendingFresh = pending && session.pendingMessageAt && (Date.now() - session.pendingMessageAt) <= 10 * 60 * 1000;

    const resolvedId = sessionId === 'new' ? `s-${chatId}-${Date.now()}` : sessionId;

    if (pendingFresh) {
      // Happy path: pending message exists and is fresh — run it
      await answerCallbackQuery(env.BOT_TOKEN, id, '▶️ Запускаю…');

      // Send placeholder, swap pinned message
      const placeholderRes = await sendMessage(env.BOT_TOKEN, chatId, '⏳ Запускаю…');
      const initialMsgId = placeholderRes?.result?.message_id ?? null;
      if (session.pinnedMsgId) unpinChatMessage(env.BOT_TOKEN, chatId, session.pinnedMsgId).catch(() => {});
      if (initialMsgId) pinChatMessage(env.BOT_TOKEN, chatId, initialMsgId).catch(() => {});

      await setSession(env.SESSIONS, chatId, {
        ...session,
        lastSessionId: resolvedId,
        lastMessageAt: Date.now(),
        pendingMessage: null,
        pendingMessageAt: null,
        activeSessionId: null,
        pinnedMsgId: initialMsgId ?? session.pinnedMsgId,
      });
      runTask(env, {
        userId: chatId,
        username: session.username,
        task: pending,
        context: null,
        sessionId: resolvedId,
        initialMsgId,
        pinnedMsgId: initialMsgId,
        telegramUserId: session.telegramUserId,
      }).catch(err => sendMessage(env.BOT_TOKEN, chatId, `❌ Ошибка: ${err.message}`));
    } else {
      // KV stale or message expired — switch to the chosen session and ask to resend
      await answerCallbackQuery(env.BOT_TOKEN, id);
      await setSession(env.SESSIONS, chatId, {
        ...session,
        activeSessionId: sessionId === 'new' ? null : resolvedId,
        lastSessionId: sessionId === 'new' ? null : resolvedId,
        pendingMessage: null,
        pendingMessageAt: null,
      });
      const where = sessionId === 'new' ? '✅ Новый диалог начат' : '✅ Диалог выбран';
      await sendMessage(env.BOT_TOKEN, chatId,
        sessionId === 'new'
          ? `${where}. Напиши свою задачу!`
          : `${where}. Напиши следующее сообщение — отвечу с учётом контекста.`
      );
    }
    return;
  }

  // ── Session detail submenu (from /sessions list tap) ─────────────────────
  // sd:<id> — show actions for a specific session
  if (data?.startsWith('sd:')) {
    if (!session) { await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Войди: /login'); return; }
    await answerCallbackQuery(env.BOT_TOKEN, id);

    const sessionId = data.slice(3);
    await sendMessageWithKeyboard(
      env.BOT_TOKEN, chatId,
      '↩ Что сделать с этим диалогом?',
      [
        [{ text: '▶️ Продолжить',                       callback_data: `sc:${sessionId}` }],
        [{ text: '📋 Сохранённая информация',            callback_data: `si:${sessionId}` }],
        [{ text: '✨ Новый диалог с этим контекстом',    callback_data: `sn:${sessionId}` }],
        [{ text: '← Назад к списку',                    callback_data: 'sl:' }],
      ]
    );
    return;
  }

  // ── Continue session (from detail submenu) ────────────────────────────────
  if (data?.startsWith('sc:')) {
    if (!session) { await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Войди: /login'); return; }
    const sessionId = data.slice(3);
    await setSession(env.SESSIONS, chatId, {
      ...session,
      activeSessionId: sessionId,
      lastSessionId: sessionId,
      lastMessageAt: Date.now(),
    });
    await answerCallbackQuery(env.BOT_TOKEN, id, '📌 Продолжаю диалог');
    await sendMessage(env.BOT_TOKEN, chatId,
      '📌 <b>Продолжаю этот диалог</b>\n\nПиши следующее сообщение — отвечу с учётом контекста.'
    );
    return;
  }

  // ── Session info (saved knowledge) ───────────────────────────────────────
  if (data?.startsWith('si:')) {
    if (!session) { await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Войди: /login'); return; }
    await answerCallbackQuery(env.BOT_TOKEN, id);

    const sessionId = data.slice(3);
    let fileData;
    try {
      fileData = await readFile(env, {
        username: session.username,
        path: `sessions/${sessionId}.json`,
      });
    } catch (e) {
      await sendMessage(env.BOT_TOKEN, chatId, `❌ Не удалось загрузить данные сессии: ${e.message}`);
      return;
    }

    let parsed;
    try { parsed = JSON.parse(fileData.content); } catch {
      await sendMessage(env.BOT_TOKEN, chatId, '❌ Не удалось прочитать файл сессии');
      return;
    }

    const lines = [
      `📋 <b>${parsed.topic}</b>`,
      `Сообщений: ${parsed.messageCount || parsed.messages?.length || '?'}`,
      `Создан: ${new Date(parsed.createdAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}`,
      `Последнее: ${timeAgo(parsed.lastAt)} назад`,
      '',
    ];

    const msgs = parsed.messages || [];
    if (msgs.length > 0) {
      lines.push('<b>История (последние сообщения):</b>');
      for (const m of msgs.slice(-4)) {
        const who = m.role === 'user' ? '👤' : '🤖';
        const snippet = m.content.slice(0, 200).replace(/\n+/g, ' ');
        lines.push(`${who} ${snippet}${m.content.length > 200 ? '…' : ''}`);
      }
    }

    const text = lines.join('\n');
    await sendMessage(env.BOT_TOKEN, chatId,
      text.length > 4000 ? text.slice(0, 3900) + '\n…' : text
    );
    return;
  }

  // ── New dialog with context from another session ──────────────────────────
  if (data?.startsWith('sn:')) {
    if (!session) { await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Войди: /login'); return; }
    const sourceSessionId = data.slice(3);
    const newId = `s-${chatId}-${Date.now()}`;
    // Store source session ID so agent loads its context into the new session
    await setSession(env.SESSIONS, chatId, {
      ...session,
      activeSessionId: null,
      lastSessionId: newId,
      lastMessageAt: Date.now(),
      contextFromSession: sourceSessionId,
    });
    await answerCallbackQuery(env.BOT_TOKEN, id, '✨ Новый диалог с контекстом');
    await sendMessage(env.BOT_TOKEN, chatId,
      '✨ <b>Новый диалог</b>\n\nКонтекст предыдущего диалога загружен. Пиши — начнём с чистого листа, но я буду знать историю.'
    );
    return;
  }

  // ── Back to sessions list ─────────────────────────────────────────────────
  if (data === 'sl:') {
    await answerCallbackQuery(env.BOT_TOKEN, id);
    if (!session) return;
    let list;
    try { list = await getSessions(env, { username: session.username, limit: 8 }); } catch { list = []; }
    if (!list.length) {
      await sendMessage(env.BOT_TOKEN, chatId, '📭 Нет диалогов.');
      return;
    }
    const buttons = list.map(s => ([{
      text: `${s.topic.slice(0, 32)} · ${timeAgo(s.lastAt)}`,
      callback_data: `sd:${s.id}`,
    }]));
    buttons.push([{ text: '✨ Новый диалог', callback_data: 'nd:' }]);
    await sendMessageWithKeyboard(env.BOT_TOKEN, chatId, '💬 <b>Диалоги</b>\n\nВыбери диалог:', buttons);
    return;
  }

  // ── New dialog flow ───────────────────────────────────────────────────────
  // nd: — open new dialog menu
  // nd:clean — fresh start
  // nd:ctx — pick session to load context from
  // nd:ctx:<id> — load context from specific session
  if (data?.startsWith('nd:')) {
    if (!session) { await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Войди: /login'); return; }

    const sub = data.slice(3);

    if (sub === '' || sub === 'clean') {
      // Clear active session, start fresh
      await setSession(env.SESSIONS, chatId, {
        ...session,
        activeSessionId: null,
        lastSessionId: null,
        contextFromSession: null,
      });
      await answerCallbackQuery(env.BOT_TOKEN, id);
      const msgId = message?.message_id;
      const text = '✏️ <b>Новый диалог</b>\n\nПиши свою задачу — начнём с нуля.';
      if (msgId) {
        await editMessage(env.BOT_TOKEN, chatId, msgId, text).catch(() =>
          sendMessage(env.BOT_TOKEN, chatId, text)
        );
      } else {
        await sendMessage(env.BOT_TOKEN, chatId, text);
      }
      return;
    }

    if (sub === 'ctx') {
      // Show session list to pick context from
      await answerCallbackQuery(env.BOT_TOKEN, id);
      let list;
      try { list = await getSessions(env, { username: session.username, limit: 6 }); } catch { list = []; }
      if (!list.length) {
        await sendMessage(env.BOT_TOKEN, chatId, '📭 Нет диалогов для загрузки контекста.');
        return;
      }
      const buttons = list.map(s => ([{
        text: `${s.topic.slice(0, 32)} · ${timeAgo(s.lastAt)}`,
        callback_data: `sn:${s.id}`,
      }]));
      await sendMessageWithKeyboard(
        env.BOT_TOKEN, chatId,
        '📚 <b>Выбери диалог</b>\n\nКонтекст загрузится в новый диалог:',
        buttons
      );
      return;
    }

    await answerCallbackQuery(env.BOT_TOKEN, id);
    return;
  }

  // ── Profile actions ───────────────────────────────────────────────────────
  if (data === 'prof:logout') {
    await answerCallbackQuery(env.BOT_TOKEN, id);
    if (!session) { await sendMessage(env.BOT_TOKEN, chatId, '⚠️ Ты уже не авторизован.'); return; }
    const name = session.name;
    await deleteSession(env.SESSIONS, chatId);
    await sendMessage(env.BOT_TOKEN, chatId,
      `👋 До встречи, ${name}!\n\nДля входа: <code>/login username password</code>`
    );
    return;
  }

  if (data === 'prof:switch') {
    await answerCallbackQuery(env.BOT_TOKEN, id);
    if (!session) { await sendMessage(env.BOT_TOKEN, chatId, '⚠️ Ты не авторизован.'); return; }
    await deleteSession(env.SESSIONS, chatId);
    await sendMessage(env.BOT_TOKEN, chatId,
      `🔄 Выход из профиля <b>${session.name}</b> выполнен.\n\n` +
      `Войди под другим логином:\n<code>/login username password</code>`
    );
    return;
  }

  // ── File browser: navigate into folder ───────────────────────────────────
  if (data?.startsWith('fl:')) {
    await answerCallbackQuery(env.BOT_TOKEN, id);
    await cmdFiles(chatId, env, data.slice(3));
    return;
  }

  // ── File browser: read file ───────────────────────────────────────────────
  if (data?.startsWith('fr:')) {
    if (!session) { await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Войди: /login'); return; }
    await answerCallbackQuery(env.BOT_TOKEN, id);

    let fileData;
    try {
      fileData = await readFile(env, { username: session.username, path: data.slice(3) });
    } catch (e) {
      await sendMessage(env.BOT_TOKEN, chatId, `❌ Не удалось прочитать файл: ${e.message}`);
      return;
    }

    const { content, truncated, size } = fileData;
    const ext = data.slice(3).split('.').pop().toLowerCase();
    let display = content;
    if (ext === 'json') {
      try { display = JSON.stringify(JSON.parse(content), null, 2); } catch {}
    }
    const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const header = `📄 <code>${data.slice(3)}</code>${truncated ? ` (первые 3.5кб из ${Math.round(size/1024)}кб)` : ''}`;
    const body = `<pre>${esc(display)}</pre>`;
    const full = `${header}\n\n${body}`;
    if (full.length <= 4096) {
      await sendMessage(env.BOT_TOKEN, chatId, full);
    } else {
      await sendMessage(env.BOT_TOKEN, chatId, header);
      await sendMessage(env.BOT_TOKEN, chatId, `<pre>${esc(display.slice(0, 3800))}</pre>`);
    }
    return;
  }

  // ── Expand quick answer — ask Claude for full answer ─────────────────────
  // ask_claude|{sessionId} — user tapped "↗️ вдумчивее плиз"
  if (data?.startsWith('ask_claude|')) {
    if (!session) { await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Войди: /login'); return; }
    await answerCallbackQuery(env.BOT_TOKEN, id, '⏳ Передаю Клоду…');

    // Send placeholder immediately so user sees feedback before agent starts
    const thinkMsg = await sendMessage(env.BOT_TOKEN, chatId, '🧠 Думаю вдумчиво…');
    const initialMsgId = thinkMsg?.result?.message_id ?? null;
    if (session.pinnedMsgId) unpinChatMessage(env.BOT_TOKEN, chatId, session.pinnedMsgId).catch(() => {});
    if (initialMsgId) pinChatMessage(env.BOT_TOKEN, chatId, initialMsgId).catch(() => {});
    if (initialMsgId) {
      setSession(env.SESSIONS, chatId, { ...session, pinnedMsgId: initialMsgId }).catch(() => {});
    }

    const sessionId = data.slice('ask_claude|'.length) || session.activeSessionId || session.lastSessionId;
    await runTask(env, {
      userId: chatId,
      username: session.username,
      sessionId,
      forceClaude: true,
<<<<<<< HEAD
      initialMsgId,
=======
      telegramUserId: session.telegramUserId,
>>>>>>> 23e8b4f (fix(chrome-ext): bind Chrome extension pairing to Telegram user ID, not group chat ID)
    }).catch(err => sendMessage(env.BOT_TOKEN, chatId, `❌ Ошибка: ${err.message}`));
    return;
  }

  await answerCallbackQuery(env.BOT_TOKEN, id);
}
