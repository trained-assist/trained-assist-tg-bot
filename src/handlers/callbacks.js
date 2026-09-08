import { getOrCreateMappedSession, setSession, deleteSession } from '../lib/kv.js';
import { sendMessage, sendMessageWithKeyboard, editMessage, pinChatMessage, unpinChatMessage } from '../lib/telegram.js';
import { answerCallbackQuery } from '../lib/telegram.js';
import { runTask, getSessions, readFile, archiveSessions, getProjects } from '../lib/agent-client.js';
import { cmdFiles, timeAgo } from './commands.js';

export async function handleCallbackQuery(cq, env) {
  const { id, data, message, from } = cq;
  const chatId = message?.chat?.id || from?.id;

  if (!chatId) return;

  const session = await getOrCreateMappedSession(env.SESSIONS, chatId, env, from?.id);

  // ── Session picker (from message.js disambiguation) ──────────────────────
  // sp:<id> or sp:new — triggered when routing was ambiguous
  if (data?.startsWith('sp:')) {
    if (!session) { await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Войди: /login'); return; }

    const sessionId = data.slice(3);
    const pending = session.pendingMessage;
    const pendingFresh = pending && session.pendingMessageAt && (Date.now() - session.pendingMessageAt) <= 10 * 60 * 1000;

    const resolvedId = sessionId === 'new' ? `s-${Math.abs(chatId)}-${Date.now()}` : sessionId;

    const msgId = message?.message_id;

    if (pendingFresh) {
      // Happy path: pending message exists and is fresh — run it
      await answerCallbackQuery(env.BOT_TOKEN, id, '▶️ Запускаю…');

      const placeholderRes = await sendMessage(env.BOT_TOKEN, chatId, '⏳ Запускаю…');
      const initialMsgId = placeholderRes?.result?.message_id ?? null;

      // Capture post-write state so .then() below spreads from the same base,
      // not the stale pre-write snapshot that still has pendingMessage/old IDs.
      const updatedSession = {
        ...session,
        lastSessionId: resolvedId,
        lastMessageAt: Date.now(),
        pendingMessage: null,
        pendingMessageAt: null,
        activeSessionId: null,
      };
      await setSession(env.SESSIONS, chatId, updatedSession);
      const label = sessionId === 'new' ? '✨ Новый диалог' : '↩️ Продолжаю диалог';
      if (msgId) editMessage(env.BOT_TOKEN, chatId, msgId, `${label} — ⏳ думаю…`, { reply_markup: { inline_keyboard: [] } }).catch(() => {});
      // Pass existing pinnedMsgId to agent — agent manages context content and may return new ID
      // MUST await so the dispatch→waitUntil chain keeps the Worker alive until the HTTP call lands.
      // Without await, Cloudflare terminates the execution context before /run is ever fetched.
      try {
        const result = await runTask(env, {
          userId: chatId,
          username: updatedSession.username,
          task: pending,
          context: null,
          sessionId: resolvedId,
          initialMsgId,
          pinnedMsgId: updatedSession.pinnedMsgId || null,
          telegramUserId: updatedSession.telegramUserId,
          projectDir: updatedSession.projectDir || null,
        });
        const newPinnedMsgId = result?.pinnedMsgId || updatedSession.pinnedMsgId || null;
        if (newPinnedMsgId !== updatedSession.pinnedMsgId) {
          await setSession(env.SESSIONS, chatId, { ...updatedSession, pinnedMsgId: newPinnedMsgId });
        }
      } catch (err) {
        sendMessage(env.BOT_TOKEN, chatId, `❌ Ошибка: ${err.message}`).catch(() => {});
      }
    } else {
      // KV stale or message expired — replace keyboard with prompt to write
      await answerCallbackQuery(env.BOT_TOKEN, id);
      await setSession(env.SESSIONS, chatId, {
        ...session,
        activeSessionId: sessionId === 'new' ? null : resolvedId,
        lastSessionId: sessionId === 'new' ? null : resolvedId,
        pendingMessage: null,
        pendingMessageAt: null,
      });
      const promptText = sessionId === 'new'
        ? '✨ Новый диалог — напиши свою задачу!'
        : '↩️ Диалог выбран — напиши следующее сообщение.';
      if (msgId) {
        editMessage(env.BOT_TOKEN, chatId, msgId, promptText, { reply_markup: { inline_keyboard: [] } }).catch(() => {});
      } else {
        await sendMessage(env.BOT_TOKEN, chatId, promptText);
      }
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
        [{ text: '🗑 Архивировать этот диалог',          callback_data: `sa:${sessionId}` }],
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
    const newId = `s-${Math.abs(chatId)}-${Date.now()}`;
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
    buttons.push([
      { text: '✨ Новый диалог', callback_data: 'nd:' },
      { text: '🗂 Архивировать', callback_data: 'ar:menu' },
    ]);
    await sendMessageWithKeyboard(env.BOT_TOKEN, chatId, '💬 <b>Диалоги</b>\n\nВыбери диалог:', buttons);
    return;
  }

  // ── Project folder picker ─────────────────────────────────────────────────
  // fp:{folderName} — select project folder (empty = root)
  // fpg:{page}      — navigate to page n of the folder list
  const FP_PAGE_SIZE = 6;

  async function showFolderPicker(chatId, session, msgId, page = 0) {
    const projects = await getProjects(env, { username: session.username, userId: chatId });
    const total = projects.length;
    const start = page * FP_PAGE_SIZE;
    const pageItems = projects.slice(start, start + FP_PAGE_SIZE);

    // Use absolute numeric index in callback_data to avoid Telegram's 64-byte limit
    // on long project path names. fp: handler re-fetches and looks up by index.
    const buttons = pageItems.map((p, i) => [{
      text: `${p.label}${p.count > 0 ? ` (${p.count})` : ''}`,
      callback_data: `fp:${start + i}`,
    }]);

    // Always show a "skip / root" escape so users are never stuck with no exit path
    buttons.push([{ text: '📂 Без папки (корень)', callback_data: 'fp:' }]);

    // Pagination row
    const navRow = [];
    if (page > 0) navRow.push({ text: '⬅️', callback_data: `fpg:${page - 1}` });
    if (start + FP_PAGE_SIZE < total) navRow.push({ text: '➡️', callback_data: `fpg:${page + 1}` });
    if (navRow.length > 0) buttons.push(navRow);

    const text = total === 0
      ? '📁 <b>Нет проектов</b> — начнём в корневой директории.'
      : '📁 <b>Выбери рабочую папку</b>\n\nЦифра в скобках — сколько раз запускал сессию:';
    if (msgId) {
      await editMessage(env.BOT_TOKEN, chatId, msgId, text, { reply_markup: { inline_keyboard: buttons } })
        .catch(() => sendMessageWithKeyboard(env.BOT_TOKEN, chatId, text, buttons));
    } else {
      await sendMessageWithKeyboard(env.BOT_TOKEN, chatId, text, buttons);
    }
  }

  if (data?.startsWith('fp:')) {
    if (!session) { await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Войди: /login'); return; }
    await answerCallbackQuery(env.BOT_TOKEN, id);
    const raw = data.slice(3); // '' = root, numeric = absolute project index
    let folderName;
    if (raw === '') {
      folderName = '';
    } else if (/^\d+$/.test(raw)) {
      const projects = await getProjects(env, { username: session.username, userId: chatId });
      folderName = projects[parseInt(raw, 10)]?.name ?? '';
    } else {
      folderName = raw; // legacy string form
    }
    await setSession(env.SESSIONS, chatId, {
      ...session,
      projectDir: folderName || null,
      activeSessionId: null,
      lastSessionId: null,
      contextFromSession: null,
    });
    const folderLabel = folderName || 'корень';
    const msgId = message?.message_id;
    const text = `✏️ <b>Новый диалог</b> — папка <code>${folderLabel}</code>\n\nПиши свою задачу — начнём с нуля.`;
    if (msgId) {
      await editMessage(env.BOT_TOKEN, chatId, msgId, text, { reply_markup: { inline_keyboard: [] } })
        .catch(() => sendMessage(env.BOT_TOKEN, chatId, text));
    } else {
      await sendMessage(env.BOT_TOKEN, chatId, text);
    }
    return;
  }

  if (data?.startsWith('fpg:')) {
    if (!session) { await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Войди: /login'); return; }
    await answerCallbackQuery(env.BOT_TOKEN, id);
    const page = parseInt(data.slice(4)) || 0;
    await showFolderPicker(chatId, session, message?.message_id, page);
    return;
  }

  // ── New dialog flow ───────────────────────────────────────────────────────
  // nd: — show folder picker to start fresh dialog
  // nd:clean — fresh start without picking folder
  // nd:ctx — pick session to load context from
  // nd:ctx:<id> — load context from specific session
  if (data?.startsWith('nd:')) {
    if (!session) { await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Войди: /login'); return; }

    const sub = data.slice(3);

    if (sub === '') {
      // Show simplified new-dialog prompt; folder picker is opt-in for advanced users
      await answerCallbackQuery(env.BOT_TOKEN, id);
      const msgId = message?.message_id;
      const currentFolder = session.projectDir
        ? `📁 <b>${session.projectDir}</b>`
        : '🏠 корневая';
      const text = `✏️ <b>Новый диалог</b>\n\nСоздаём в папке ${currentFolder}.`;
      const buttons = [
        [{ text: '✏️ Создать', callback_data: 'nd:clean' }],
        [{ text: '📁 Выбрать папку  · для тех, кто хочет структурировать диалоги', callback_data: 'nd:folder' }],
      ];
      const kb = { reply_markup: { inline_keyboard: buttons } };
      if (msgId) {
        await editMessage(env.BOT_TOKEN, chatId, msgId, text, kb).catch(() =>
          sendMessageWithKeyboard(env.BOT_TOKEN, chatId, text, buttons)
        );
      } else {
        await sendMessageWithKeyboard(env.BOT_TOKEN, chatId, text, buttons);
      }
      return;
    }

    if (sub === 'folder') {
      // Advanced: show folder picker
      await answerCallbackQuery(env.BOT_TOKEN, id);
      await showFolderPicker(chatId, session, message?.message_id, 0);
      return;
    }

    if (sub === 'clean') {
      // Clear active session, start fresh (keep current projectDir)
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

  // ── Archive sessions menu ─────────────────────────────────────────────────
  // ar:menu — show archive options
  // ar:all / ar:keep:N — execute bulk archive
  // ar:pick — show session list for individual archive selection
  if (data?.startsWith('ar:')) {
    if (!session) { await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Войди: /login'); return; }

    const sub = data.slice(3);

    if (sub === 'menu') {
      await answerCallbackQuery(env.BOT_TOKEN, id);
      await sendMessageWithKeyboard(
        env.BOT_TOKEN, chatId,
        '🗂 <b>Архивировать диалоги</b>\n\nВыбери что архивировать:',
        [
          [{ text: '🗂 Архивировать все',                      callback_data: 'ar:all' }],
          [{ text: '🗂 Оставить последний, остальные в архив', callback_data: 'ar:keep:1' }],
          [{ text: '🗂 Оставить 2 последних',                  callback_data: 'ar:keep:2' }],
          [{ text: '🗂 Оставить 3 последних',                  callback_data: 'ar:keep:3' }],
          [{ text: '📋 Выбрать отдельный диалог',              callback_data: 'ar:pick' }],
          [{ text: '← Назад к диалогам',                      callback_data: 'sl:' }],
        ]
      );
      return;
    }

    if (sub === 'pick') {
      await answerCallbackQuery(env.BOT_TOKEN, id);
      let list;
      try { list = await getSessions(env, { username: session.username, limit: 20 }); } catch { list = []; }
      if (!list.length) {
        await sendMessage(env.BOT_TOKEN, chatId, '📭 Нет диалогов для архивирования.');
        return;
      }
      const buttons = list.map(s => ([{
        text: `${s.topic.slice(0, 32)} · ${timeAgo(s.lastAt)}`,
        callback_data: `sa:${s.id}`,
      }]));
      buttons.push([{ text: '← Отмена', callback_data: 'ar:menu' }]);
      await sendMessageWithKeyboard(
        env.BOT_TOKEN, chatId,
        '📋 <b>Выбери диалог для архивирования:</b>',
        buttons
      );
      return;
    }

    // ar:all or ar:keep:N
    let keepLast = 0;
    if (sub === 'all') {
      keepLast = 0;
    } else if (sub.startsWith('keep:')) {
      keepLast = parseInt(sub.slice(5), 10) || 0;
    } else {
      await answerCallbackQuery(env.BOT_TOKEN, id);
      return;
    }

    await answerCallbackQuery(env.BOT_TOKEN, id, '⏳ Архивирую…');

    let list;
    try {
      list = await getSessions(env, { username: session.username, limit: 100 });
    } catch (e) {
      await sendMessage(env.BOT_TOKEN, chatId, `❌ Не удалось получить диалоги: ${e.message}`);
      return;
    }

    const toArchive = keepLast > 0 ? list.slice(keepLast) : list;
    if (toArchive.length === 0) {
      await sendMessage(env.BOT_TOKEN, chatId, '✅ Нечего архивировать — диалогов столько, сколько хочешь оставить.');
      return;
    }

    try {
      const result = await archiveSessions(env, {
        username: session.username,
        sessionIds: toArchive.map(s => s.id),
      });
      const n = result.archived ?? toArchive.length;
      await sendMessage(env.BOT_TOKEN, chatId, `✅ Архивировано диалогов: <b>${n}</b>`);
    } catch (e) {
      await sendMessage(env.BOT_TOKEN, chatId, `❌ Ошибка архивирования: ${e.message}`);
    }
    return;
  }

  // ── Archive individual session ─────────────────────────────────────────────
  // sa:<id> — archive one session (from detail submenu or from pick list)
  if (data?.startsWith('sa:')) {
    if (!session) { await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Войди: /login'); return; }
    const sessionId = data.slice(3);
    await answerCallbackQuery(env.BOT_TOKEN, id, '⏳ Архивирую…');

    try {
      await archiveSessions(env, {
        username: session.username,
        sessionIds: [sessionId],
      });
      const msgId = message?.message_id;
      const text = '✅ <b>Диалог архивирован.</b>';
      if (msgId) {
        editMessage(env.BOT_TOKEN, chatId, msgId, text, { reply_markup: { inline_keyboard: [] } }).catch(() => {});
      } else {
        await sendMessage(env.BOT_TOKEN, chatId, text);
      }
    } catch (e) {
      await sendMessage(env.BOT_TOKEN, chatId, `❌ Ошибка: ${e.message}`);
    }
    return;
  }

  // ── Expand quick answer — ask Claude for full answer ─────────────────────
  // ask_claude|{sessionId} — user tapped "↗️ вдумчивее плиз"
  if (data?.startsWith('ask_claude|')) {
    if (!session) { await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Войди: /login'); return; }
    await answerCallbackQuery(env.BOT_TOKEN, id, '⏳ Передаю Клоду…');

    const thinkMsg = await sendMessage(env.BOT_TOKEN, chatId, '🧠 Думаю вдумчиво…');
    const initialMsgId = thinkMsg?.result?.message_id ?? null;

    const sessionId = data.slice('ask_claude|'.length) || session.activeSessionId || session.lastSessionId;
    await runTask(env, {
      userId: chatId,
      username: session.username,
      sessionId,
      forceClaude: true,
      initialMsgId,
      telegramUserId: session.telegramUserId,
      projectDir: session.projectDir || null,
    }).catch(err => sendMessage(env.BOT_TOKEN, chatId, `❌ Ошибка: ${err.message}`));
    return;
  }

  await answerCallbackQuery(env.BOT_TOKEN, id);
}
