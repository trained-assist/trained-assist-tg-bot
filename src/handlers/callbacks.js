import { openProjectChoice, chooseProject } from '../lib/project-choice.js';
import { rejectExpiredUI, PICKER_TTL_MS, pendingMessageFresh } from '../lib/transient-ui.js';
import { getSession, setSession, deleteSession, newSessionId, withKvConsistencyRetry } from '../lib/kv.js';
import { sendMessage, sendMessageWithKeyboard, editMessage, pinChatMessage, unpinChatMessage } from '../lib/telegram.js';
import { answerCallbackQuery } from '../lib/telegram.js';
import { runTask, getSessions, readFile, archiveSessions, getProjects } from '../lib/agent-client.js';
import { cmdFiles, timeAgo, renderSessionList } from './commands.js';

export async function handleCallbackQuery(cq, env) {
  const { id, data, message, from } = cq;
  const initiatedAt = Date.now();
  const chatId = message?.chat?.id || from?.id;

  if (!chatId) return;

  let session = await getSession(env.SESSIONS, chatId);

  if (await rejectExpiredUI(cq, env, session)) return;

  if (data?.startsWith('pc:')) return chooseProject(cq, env, session);

  // ── Session picker (from message.js disambiguation) ──────────────────────
  // sp:<id> or sp:new — triggered when routing was ambiguous
  if (data?.startsWith('sp:')) {
    if (!session) { await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Войди: /login'); return; }

    session = await withKvConsistencyRetry(env.SESSIONS, chatId, session, pendingMessageFresh);
    const sessionId = data.slice(3);
    const pending = session.pendingMessage;
    const pendingFresh = pendingMessageFresh(session);

    const resolvedId = sessionId === 'new' ? newSessionId(chatId) : sessionId;

    const msgId = message?.message_id;

    if (sessionId === 'new') {
      await answerCallbackQuery(env.BOT_TOKEN, id);
      try {
        await openProjectChoice(env, chatId, session, {
          input: pendingFresh ? (session.pendingOriginalMessage || { chat: { id: chatId }, text: pending }) : null,
          opts: session.pendingOriginalOpts || {},
        });
      } catch (err) { await sendMessage(env.BOT_TOKEN, chatId, `⚠️ ${err.message}`); }
      return;
    }

    if (pendingFresh) {
      // Happy path: pending message exists and is fresh — run it
      await answerCallbackQuery(env.BOT_TOKEN, id, '📨 Передаю задачу…');

      const placeholderRes = await sendMessage(env.BOT_TOKEN, chatId, '📨 Передаю задачу агенту…');
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
      if (msgId) await editMessage(env.BOT_TOKEN, chatId, msgId, `${label} — задача передана на запуск`, { lifecycleEnv: env, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      // Pass existing pinnedMsgId to agent — agent manages context content and may return new ID
      // MUST await so the dispatch→waitUntil chain keeps the Worker alive until the HTTP call lands.
      // Without await, Cloudflare terminates the execution context before /run is ever fetched.
      try {
        const result = await runTask(env, {
      initiatedAt, threadId: message?.message_thread_id || null,
      requestId: `callback-${id}`,
          userId: chatId,
          username: updatedSession.username,
          task: pending,
          context: null,
          sessionId: resolvedId,
          forceNew: sessionId === 'new',
          initialMsgId,
          pinnedMsgId: updatedSession.pinnedMsgId || null,
          telegramUserId: updatedSession.telegramUserId,
          projectId: updatedSession.projectId || null,
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
        await editMessage(env.BOT_TOKEN, chatId, msgId, promptText, { lifecycleEnv: env, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      } else {
        await sendMessage(env.BOT_TOKEN, chatId, promptText);
      }
    }
    return;
  }

  // ── Project picker (from message.js new-dialog, issue #517) ───────────────
  // pp:<index> — bind chosen typed project; pp:new — create a project from the first
  // message (provisional name). Runs the stashed pending message, mirroring sp:.
  if (data?.startsWith('pp:')) {
    if (!session) { await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Войди: /login'); return; }
    session = await withKvConsistencyRetry(env.SESSIONS, chatId, session, pendingMessageFresh);
    const raw = data.slice(3);
    const pending = session.pendingMessage;
    const pendingFresh = pendingMessageFresh(session);
    const msgId = message?.message_id;

    if (!pendingFresh) {
      await answerCallbackQuery(env.BOT_TOKEN, id);
      await setSession(env.SESSIONS, chatId, { ...session, pendingMessage: null, pendingMessageAt: null });
      const t = '⌛ Сообщение устарело — напиши задачу заново, спрошу проект снова.';
      if (msgId) await editMessage(env.BOT_TOKEN, chatId, msgId, t, { lifecycleEnv: env, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      else await sendMessage(env.BOT_TOKEN, chatId, t);
      return;
    }

    // Resolve chosen project id (existing) OR a new-project name (from the first message).
    let projectId = null, newProjectName = null, label = '';
    if (raw === 'new') {
      newProjectName = (pending.split('\n')[0] || '').trim().slice(0, 60) || 'Новый проект';
      label = `➕ ${newProjectName}`;
    } else {
      const projects = await getProjects(env, { username: session.username, userId: chatId });
      const chosen = projects[parseInt(raw, 10)];
      if (!chosen) { await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Проект не найден'); return; }
      projectId = chosen.id;
      label = `📁 ${chosen.label || chosen.name}`;
    }

    await answerCallbackQuery(env.BOT_TOKEN, id, '📨 Передаю задачу…');
    const resolvedId = newSessionId(chatId);
    const placeholderRes = await sendMessage(env.BOT_TOKEN, chatId, '📨 Передаю задачу агенту…');
    const initialMsgId = placeholderRes?.result?.message_id ?? null;

    const updatedSession = {
      ...session,
      lastSessionId: resolvedId,
      lastMessageAt: Date.now(),
      pendingMessage: null,
      pendingMessageAt: null,
      activeSessionId: null,
      // Remember the picked project as the chat's hint (new-project id is unknown here;
      // the agent stores it on the session record and re-binds on continuation).
      projectId: projectId || session.projectId || null,
    };
    await setSession(env.SESSIONS, chatId, updatedSession);
    if (msgId) await editMessage(env.BOT_TOKEN, chatId, msgId, `${label} — задача передана на запуск`, { lifecycleEnv: env, reply_markup: { inline_keyboard: [] } }).catch(() => {});

    try {
      const result = await runTask(env, {
      initiatedAt, threadId: message?.message_thread_id || null,
      requestId: `callback-${id}`,
        userId: chatId,
        username: updatedSession.username,
        task: pending,
        context: null,
        sessionId: resolvedId,
        forceNew: true,
        initialMsgId,
        pinnedMsgId: updatedSession.pinnedMsgId || null,
        telegramUserId: updatedSession.telegramUserId,
        projectId,
        newProjectName,
      });
      const newPinnedMsgId = result?.pinnedMsgId || updatedSession.pinnedMsgId || null;
      if (newPinnedMsgId !== updatedSession.pinnedMsgId) {
        await setSession(env.SESSIONS, chatId, { ...updatedSession, pinnedMsgId: newPinnedMsgId });
      }
    } catch (err) {
      sendMessage(env.BOT_TOKEN, chatId, `❌ Ошибка: ${err.message}`).catch(() => {});
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
      ], {}, env
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
      activeSessionIsNew: false,
      projectSelectionSessionId: null,
      pendingNewProject: false,
      contextFromSession: null,
      pendingProjectChoice: session.pendingProjectChoice ? { ...session.pendingProjectChoice, suspended: true } : null,
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
    await answerCallbackQuery(env.BOT_TOKEN, id);
    try { await openProjectChoice(env, chatId, session, { contextFromSession: sourceSessionId }); }
    catch (err) { await sendMessage(env.BOT_TOKEN, chatId, `⚠️ ${err.message}`); }
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
    const { text, buttons } = renderSessionList(list, { callbackPrefix: 'sd' });
    buttons.push([
      { text: '✨ Новый диалог', callback_data: 'nd:' },
      { text: '🗂 Архивировать', callback_data: 'ar:menu' },
    ]);
    await sendMessageWithKeyboard(env.BOT_TOKEN, chatId, text, buttons, {}, env);
    return;
  }

  // ── New dialog flow ───────────────────────────────────────────────────────
  // nd: / nd:clean — immediately choose a project before writing the task.
  // nd:ctx   — pick session to load context from
  // nd:ctx:<id> — load context from specific session
  if (data?.startsWith('nd:')) {
    if (!session) { await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Войди: /login'); return; }

    const sub = data.slice(3);

    if (sub === '' || sub === 'clean') {
      await answerCallbackQuery(env.BOT_TOKEN, id);
      try { await openProjectChoice(env, chatId, session); }
      catch (err) { await sendMessage(env.BOT_TOKEN, chatId, `⚠️ ${err.message}`); }
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
      const { text, buttons } = renderSessionList(list, {
        callbackPrefix: 'sn',
        header: '📚 <b>Загрузить контекст в новый диалог</b>',
        hint: 'Выбери номер диалога ниже — его контекст загрузится в новый:',
      });
      await sendMessageWithKeyboard(env.BOT_TOKEN, chatId, text, buttons, {}, env);
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
        ], {}, env
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
        buttons, {}, env
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
        await editMessage(env.BOT_TOKEN, chatId, msgId, text, { lifecycleEnv: env, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      } else {
        await sendMessage(env.BOT_TOKEN, chatId, text);
      }
    } catch (e) {
      await sendMessage(env.BOT_TOKEN, chatId, `❌ Ошибка: ${e.message}`);
    }
    return;
  }

  // ── Intake launch (manual accumulator) ───────────────────────────────────
  // intake_run — «▶️ Запустить» under the collector message: flush the buffered
  // messages for this chat and run them as one. The DO derives everything from
  // its own state (keyed by chatId), so no payload is needed.
  // «▶️ Запустить проработку» (intake_run) — ЕДИНЫЙ путь запуска: сливает накопленный
  // буфер и запускает по нему проработку. `workrun|…` — устаревшая кнопка «⏻ Запустить
  // проработку» из старых чатов; раньше она перезапускала sess.lastUserMessage в обход
  // буфера (десинк «ушло не на то», #530 §B). Теперь ведёт в тот же flush — один источник.
  if (data === 'intake_run' || data?.startsWith('workrun|')) {
    if (!session) { await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Войди: /login'); return; }
    await answerCallbackQuery(env.BOT_TOKEN, id, '📨 Передаю задачу…');
    if (env.INTAKE) {
      const stub = env.INTAKE.get(env.INTAKE.idFromName(String(chatId)));
      const r = await stub.fetch('https://intake/flush', { method: 'POST' })
        .then(x => x.json()).catch(err => { sendMessage(env.BOT_TOKEN, chatId, `❌ Ошибка: ${err.message}`); return null; });
      if (r?.empty) {
        await sendMessage(env.BOT_TOKEN, chatId,
          '📭 Буфер пуст — напиши запрос, потом жми «▶️ Запустить проработку».');
      }
    }
    return;
  }

  // «❓ Уточнить задачу» (clarify|) removed — owner reversal (INTAKE-REFACTOR-SPEC.md
  // §9.2, 2026-09-14): bad idea, no button generates this callback anymore. A stale
  // clarify| tap from an old chat falls through to the plain ack at the bottom.

  // ── Continue-by-plan (§C #530) ────────────────────────────────────────────
  // plan|{sessionId} — «▶️ Действуй дальше по плану» under a deep result: continue the
  // SAME session by the plan the agent just described, no re-ask. Reply-path (forceClaude,
  // deep) so it runs the resilient brain and keeps the sticky deep mode.
  if (data?.startsWith('plan|')) {
    if (!session) { await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Войди: /login'); return; }
    await answerCallbackQuery(env.BOT_TOKEN, id, '▶️ Продолжаю по плану…');
    const sessionId = data.slice('plan|'.length) || session.activeSessionId || session.lastSessionId;
    const thinkMsg = await sendMessage(env.BOT_TOKEN, chatId, '▶️ Продолжаю по плану…');
    const initialMsgId = thinkMsg?.result?.message_id ?? null;
    await runTask(env, {
      initiatedAt, threadId: message?.message_thread_id || null,
      requestId: `callback-${id}`,
      userId: chatId,
      username: session.username,
      sessionId,
      task: '[Продолжай по плану, который ты только что описал выше. Выполняй шаги по порядку до конца, не переспрашивай — план уже согласован нажатием кнопки «Действуй дальше по плану».]',
      forceClaude: true,
      mode: 'deep',
      initialMsgId,
      telegramUserId: session.telegramUserId,
      projectId: session.projectId || null,
    }).catch(err => sendMessage(env.BOT_TOKEN, chatId, `❌ Ошибка: ${err.message}`));
    return;
  }

  // ── Escalate a quick answer (requirements-log [062], 2026-09-15) ─────────
  // qa_more|{sessionId} — «🔎 Разобраться подробнее» under a template quick-answer
  // (ping/hh-quick/etc. never touched Claude). §9.2 killed the generic one-shot
  // action markup, which left quick answers with NO way to hand themselves to
  // Claude — the user had to retype the question into the accumulator and hope
  // it landed on the same session. This reruns the SAME session forceClaude+deep;
  // agent-side (runner.js) already wraps the prior quick reply as context when it
  // sees forceClaude+deep+no-explicit-task, so the escalation carries the original
  // exchange instead of losing it.
  if (data?.startsWith('qa_more|')) {
    if (!session) { await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Войди: /login'); return; }
    await answerCallbackQuery(env.BOT_TOKEN, id, '🔎 Разбираюсь подробнее…');
    const sessionId = data.slice('qa_more|'.length) || session.activeSessionId || session.lastSessionId;
    const thinkMsg = await sendMessage(env.BOT_TOKEN, chatId, '🔎 Разбираюсь подробнее…');
    const initialMsgId = thinkMsg?.result?.message_id ?? null;
    await runTask(env, {
      initiatedAt, threadId: message?.message_thread_id || null,
      requestId: `callback-${id}`,
      userId: chatId,
      username: session.username,
      sessionId,
      forceClaude: true,
      mode: 'deep',
      initialMsgId,
      telegramUserId: session.telegramUserId,
      projectId: session.projectId || null,
    }).catch(err => sendMessage(env.BOT_TOKEN, chatId, `❌ Ошибка: ${err.message}`));
    return;
  }

  // ── Multi-button menu (§D) ────────────────────────────────────────────────
  // menu|{sessionId}|{idx} — Claude's answer offered 2-4 explicit alternatives (agent
  // side detects this the same way it detects a plan) and we rendered one button per
  // option. The tap carries only the index, not the label text — the session already
  // has its own last answer in context and knows what option N means, so we don't
  // burn callback_data bytes re-stating it.
  if (data?.startsWith('menu|')) {
    if (!session) { await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Войди: /login'); return; }
    const rest = data.slice('menu|'.length);
    const sepIdx = rest.lastIndexOf('|');
    const sessionId = (sepIdx === -1 ? rest : rest.slice(0, sepIdx)) || session.activeSessionId || session.lastSessionId;
    const idxNum = Number(sepIdx === -1 ? NaN : rest.slice(sepIdx + 1));
    const optionNo = Number.isFinite(idxNum) ? idxNum + 1 : 1;
    await answerCallbackQuery(env.BOT_TOKEN, id, `▶️ Вариант ${optionNo}…`);
    const thinkMsg = await sendMessage(env.BOT_TOKEN, chatId, `▶️ Продолжаю с вариантом ${optionNo}…`);
    const initialMsgId = thinkMsg?.result?.message_id ?? null;
    await runTask(env, {
      initiatedAt, threadId: message?.message_thread_id || null,
      requestId: `callback-${id}`,
      userId: chatId,
      username: session.username,
      sessionId,
      task: `[Пользователь выбрал вариант ${optionNo} из меню, которое ты только что предложил выше (нумерация с 1). Действуй по этому варианту дальше, не переспрашивай — выбор уже сделан нажатием кнопки.]`,
      forceClaude: true,
      mode: 'deep',
      initialMsgId,
      telegramUserId: session.telegramUserId,
      projectId: session.projectId || null,
    }).catch(err => sendMessage(env.BOT_TOKEN, chatId, `❌ Ошибка: ${err.message}`));
    return;
  }

  await answerCallbackQuery(env.BOT_TOKEN, id);
}
