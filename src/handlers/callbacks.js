import { openProjectChoice, chooseProject, startNewDialog } from '../lib/project-choice.js';
import { rejectExpiredUI, PICKER_TTL_MS, pendingMessageFresh, projectChoiceExpired } from '../lib/transient-ui.js';
import { readPicker } from '../lib/picker-mirror.js';
import { getSession, setSession, deleteSession, newSessionId, withKvConsistencyRetry } from '../lib/kv.js';
import { sendDocument, sendMessage, sendMessageWithKeyboard, editMessage, editMessageReplyMarkup, pinChatMessage, unpinChatMessage } from '../lib/telegram.js';
import { answerCallbackQuery } from '../lib/telegram.js';
import { journalLoginUrl } from '../lib/journal-link.js';
import { armSupplement, takeSupplement, releaseToIntake } from '../lib/supplement.js';
import { conversationKey, threadExtra, threadIdOf } from '../conversation-context.js';
import { renderSnapshotDocument } from '../input-assembly.js';
import { runTask, getSessions, readFile, archiveSessions, getProjects, stopTask, fetchRunInput, orphanChecklistAction } from '../lib/agent-client.js';
import { cmdFiles, timeAgo, renderSessionList } from './commands.js';
import { stopChat, stopReplyText } from '../lib/stop-chat.js';
import { controlPlaneStopDisabled } from '../lib/control-plane-stop-gate.js';

// Topic-aware outbound helpers (issue #255): every NEW message must carry
// message_thread_id so it lands in the same forum topic as its trigger. editMessage
// needs no thread — it targets an existing message_id that already belongs to a
// topic. threadExtra() is empty when there is no valid thread (hard guard).
function sendT(env, chatId, threadId, text, extra = {}) {
  return sendMessage(env.BOT_TOKEN, chatId, text, { ...extra, ...threadExtra(threadId) });
}
function sendKbT(env, chatId, threadId, text, keyboard, extra = {}, lifecycleEnv = env) {
  return sendMessageWithKeyboard(env.BOT_TOKEN, chatId, text, keyboard, { ...extra, ...threadExtra(threadId) }, lifecycleEnv);
}
// One-tap journal link: signed for the profile that PRESSED the button (not the
// one that ran the task), one-time, valid 10 minutes. URL button, not text: no
// link preview fetches it; a stale one → re-tap.
async function sendJournalLink(env, chatId, threadId, { username, sessionId }) {
  const url = await journalLoginUrl(env, { username, sessionId });
  return sendT(env, chatId, threadId, '📜 Журнал диалога — ссылка одноразовая, входит под твоим профилем, действует 10 минут.',
    { reply_markup: { inline_keyboard: [[{ text: '📜 Открыть журнал', url }]] } });
}

function needsControlPlaneOwnership(data) {
  return ['intake_run', 'intake_parallel', 'intake_cancel', 'intake_stopsupp', 'intake_stopnew'].includes(data)
    || /^intake_discard\|\d+$/.test(data || '')
    || /^ws\|(explore|answer|auto)\|\d+$/.test(data || '')
    || ['workrun|', 'intake_stopyes|', 'intake_stopno|', 'stop|', 'stopok|', 'stopno|'].some(prefix => data?.startsWith(prefix));
}

export async function controlPlaneCallbackOwned(cq, env, session) {
  if (env.EXECUTION_BACKEND !== 'control-plane' || !needsControlPlaneOwnership(cq.data)) return true;
  const messageId = cq.message?.message_id;
  const chatId = cq.message?.chat?.id;
  if (!env.INTAKE || !session?.username || !chatId || !Number.isSafeInteger(messageId) || messageId <= 0) return false;
  try {
    const stub = env.INTAKE.get(env.INTAKE.idFromName(conversationKey(chatId, threadIdOf(cq.message))));
    const response = await stub.fetch('https://intake/callback-owner', { method: 'POST',
      body: JSON.stringify({ messageId, callbackData: cq.data, username: session.username }) });
    if (!response.ok) return false;
    return (await response.json())?.owned === true;
  } catch { return false; }
}

function callbackSource(cq, env, session) {
  return env.EXECUTION_BACKEND === 'control-plane'
    ? { sourceMessageId: cq.message.message_id, callbackData: cq.data, username: session.username } : {};
}

export async function handleCallbackQuery(cq, env) {
  const { id, data, message, from } = cq;
  const initiatedAt = Date.now();
  const chatId = message?.chat?.id || from?.id;
  const threadId = threadIdOf(message);

  if (!chatId) return;
  if (controlPlaneStopDisabled(env) && (data?.startsWith('intake_stop')
      || /^(stop|stopok|stopno|sup|supok|supno)\|/.test(data || ''))) {
    await answerCallbackQuery(env.BOT_TOKEN, id, 'Остановка Control Plane сейчас отключена. Собранный ввод сохранён.');
    return;
  }

  let session = await getSession(env.SESSIONS, chatId, threadId);
  if (!(await controlPlaneCallbackOwned(cq, env, session))) {
    await answerCallbackQuery(env.BOT_TOKEN, id, '⌛ Кнопка устарела или её актуальность не подтверждена — используй текущее сообщение.');
    return;
  }

  // KV may still hold an older picker than the one tapped (opened by the IntakeBuffer
  // DO in another colo) — trust the strongly-consistent DO mirror for this message.
  if (data?.startsWith('pc:') && session && projectChoiceExpired(session.pendingProjectChoice, cq)) {
    const mirrored = await readPicker(env, chatId, threadId);
    if (mirrored && !projectChoiceExpired(mirrored, cq)) session = { ...session, pendingProjectChoice: mirrored };
  }

  if (await rejectExpiredUI(cq, env, session)) return;

  if (data?.startsWith('pc:')) return chooseProject(cq, env, session);

  // ── Session picker (from message.js disambiguation) ──────────────────────
  // sp:<id> or sp:new — triggered when routing was ambiguous
  if (data?.startsWith('sp:')) {
    if (!session) { await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Войди: /login'); return; }

    session = await withKvConsistencyRetry(env.SESSIONS, chatId, session, pendingMessageFresh, 400, threadId);
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
      } catch (err) { await sendT(env, chatId, threadId, `⚠️ ${err.message}`); }
      return;
    }

    if (pendingFresh) {
      // Happy path: pending message exists and is fresh — run it
      await answerCallbackQuery(env.BOT_TOKEN, id, '📨 Передаю задачу…');

      const placeholderRes = await sendT(env, chatId, threadId, '📨 Передаю задачу агенту…');
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
      await setSession(env.SESSIONS, chatId, updatedSession, threadId);
      const label = sessionId === 'new' ? '✨ Новый диалог' : '↩️ Продолжаю диалог';
      if (msgId) await editMessage(env.BOT_TOKEN, chatId, msgId, `${label} — задача передана на запуск`, { lifecycleEnv: env, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      // Pass existing pinnedMsgId to agent — agent manages context content and may return new ID
      // MUST await so the dispatch→waitUntil chain keeps the Worker alive until the HTTP call lands.
      // Without await, Cloudflare terminates the execution context before /run is ever fetched.
      try {
        const result = await runTask(env, {
      initiatedAt, threadId: threadId,
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
          await setSession(env.SESSIONS, chatId, { ...updatedSession, pinnedMsgId: newPinnedMsgId }, threadId);
        }
      } catch (err) {
        sendT(env, chatId, threadId, `❌ Ошибка: ${err.message}`).catch(() => {});
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
      }, threadId);
      const promptText = sessionId === 'new'
        ? '✨ Новый диалог — напиши свою задачу!'
        : '↩️ Диалог выбран — напиши следующее сообщение.';
      if (msgId) {
        await editMessage(env.BOT_TOKEN, chatId, msgId, promptText, { lifecycleEnv: env, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      } else {
        await sendT(env, chatId, threadId, promptText);
      }
    }
    return;
  }

  // ── Project picker (from message.js new-dialog, issue #517) ───────────────
  // pp:<index> — bind chosen typed project; pp:new — create a project from the first
  // message (provisional name). Runs the stashed pending message, mirroring sp:.
  if (data?.startsWith('pp:')) {
    if (!session) { await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Войди: /login'); return; }
    session = await withKvConsistencyRetry(env.SESSIONS, chatId, session, pendingMessageFresh, 400, threadId);
    const raw = data.slice(3);
    const pending = session.pendingMessage;
    const pendingFresh = pendingMessageFresh(session);
    const msgId = message?.message_id;

    if (!pendingFresh) {
      await answerCallbackQuery(env.BOT_TOKEN, id);
      await setSession(env.SESSIONS, chatId, { ...session, pendingMessage: null, pendingMessageAt: null }, threadId);
      const t = '⌛ Сообщение устарело — напиши задачу заново, спрошу проект снова.';
      if (msgId) await editMessage(env.BOT_TOKEN, chatId, msgId, t, { lifecycleEnv: env, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      else await sendT(env, chatId, threadId, t);
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
    const placeholderRes = await sendT(env, chatId, threadId, '📨 Передаю задачу агенту…');
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
    await setSession(env.SESSIONS, chatId, updatedSession, threadId);
    if (msgId) await editMessage(env.BOT_TOKEN, chatId, msgId, `${label} — задача передана на запуск`, { lifecycleEnv: env, reply_markup: { inline_keyboard: [] } }).catch(() => {});

    try {
      const result = await runTask(env, {
      initiatedAt, threadId: threadId,
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
        projectPicked: !!projectId, // explicit menu choice → agent pins the chat (#1318)
        newProjectName,
      });
      const newPinnedMsgId = result?.pinnedMsgId || updatedSession.pinnedMsgId || null;
      if (newPinnedMsgId !== updatedSession.pinnedMsgId) {
        await setSession(env.SESSIONS, chatId, { ...updatedSession, pinnedMsgId: newPinnedMsgId }, threadId);
      }
    } catch (err) {
      sendT(env, chatId, threadId, `❌ Ошибка: ${err.message}`).catch(() => {});
    }
    return;
  }

  // ── Session detail submenu (from /sessions list tap) ─────────────────────
  // sd:<id> — show actions for a specific session
  if (data?.startsWith('sd:')) {
    if (!session) { await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Войди: /login'); return; }
    await answerCallbackQuery(env.BOT_TOKEN, id);

    const sessionId = data.slice(3);
    await sendKbT(env, chatId, threadId,
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
      projectPicked: false,
      pendingNewProject: false,
      contextFromSession: null,
      pendingProjectChoice: session.pendingProjectChoice ? { ...session.pendingProjectChoice, suspended: true } : null,
      lastSessionId: sessionId,
      lastMessageAt: Date.now(),
    }, threadId);
    await answerCallbackQuery(env.BOT_TOKEN, id, '📌 Продолжаю диалог');
    await sendT(env, chatId, threadId,
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
      await sendT(env, chatId, threadId, `❌ Не удалось загрузить данные сессии: ${e.message}`);
      return;
    }

    let parsed;
    try { parsed = JSON.parse(fileData.content); } catch {
      await sendT(env, chatId, threadId, '❌ Не удалось прочитать файл сессии');
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
    await sendT(env, chatId, threadId,
      text.length > 4000 ? text.slice(0, 3900) + '\n…' : text
    );
    return;
  }

  // ── New dialog with context from another session ──────────────────────────
  if (data?.startsWith('sn:')) {
    if (!session) { await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Войди: /login'); return; }
    const sourceSessionId = data.slice(3);
    await answerCallbackQuery(env.BOT_TOKEN, id);
    try { await startNewDialog(env, chatId, session, { contextFromSession: sourceSessionId }); }
    catch (err) { await sendT(env, chatId, threadId, `⚠️ ${err.message}`); }
    return;
  }

  // ── Back to sessions list ─────────────────────────────────────────────────
  if (data === 'sl:') {
    await answerCallbackQuery(env.BOT_TOKEN, id);
    if (!session) return;
    let list;
    try { list = await getSessions(env, { username: session.username, limit: 8 }); } catch { list = []; }
    if (!list.length) {
      await sendT(env, chatId, threadId, '📭 Нет диалогов.');
      return;
    }
    const { text, buttons } = renderSessionList(list, { callbackPrefix: 'sd' });
    buttons.push([
      { text: '✨ Новый диалог', callback_data: 'nd:' },
      { text: '🗂 Архивировать', callback_data: 'ar:menu' },
    ]);
    await sendKbT(env, chatId, threadId, text, buttons, {}, env);
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
      try { await startNewDialog(env, chatId, session); }
      catch (err) { await sendT(env, chatId, threadId, `⚠️ ${err.message}`); }
      return;
    }

    if (sub === 'ctx') {
      // Show session list to pick context from
      await answerCallbackQuery(env.BOT_TOKEN, id);
      let list;
      try { list = await getSessions(env, { username: session.username, limit: 6 }); } catch { list = []; }
      if (!list.length) {
        await sendT(env, chatId, threadId, '📭 Нет диалогов для загрузки контекста.');
        return;
      }
      const { text, buttons } = renderSessionList(list, {
        callbackPrefix: 'sn',
        header: '📚 <b>Загрузить контекст в новый диалог</b>',
        hint: 'Выбери номер диалога ниже — его контекст загрузится в новый:',
      });
      await sendKbT(env, chatId, threadId, text, buttons, {}, env);
      return;
    }

    await answerCallbackQuery(env.BOT_TOKEN, id);
    return;
  }

  // ── Profile actions ───────────────────────────────────────────────────────
  if (data === 'prof:logout') {
    await answerCallbackQuery(env.BOT_TOKEN, id);
    if (!session) { await sendT(env, chatId, threadId, '⚠️ Ты уже не авторизован.'); return; }
    const name = session.name;
    await deleteSession(env.SESSIONS, chatId);
    await sendT(env, chatId, threadId,
      `👋 До встречи, ${name}!\n\nДля входа: <code>/login username password</code>`
    );
    return;
  }

  if (data === 'prof:switch') {
    await answerCallbackQuery(env.BOT_TOKEN, id);
    if (!session) { await sendT(env, chatId, threadId, '⚠️ Ты не авторизован.'); return; }
    await deleteSession(env.SESSIONS, chatId);
    await sendT(env, chatId, threadId,
      `🔄 Выход из профиля <b>${session.name}</b> выполнен.\n\n` +
      `Войди под другим логином:\n<code>/login username password</code>`
    );
    return;
  }

  // ── File browser: navigate into folder ───────────────────────────────────
  if (data?.startsWith('fl:')) {
    await answerCallbackQuery(env.BOT_TOKEN, id);
    await cmdFiles(chatId, env, data.slice(3), threadId);
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
      await sendT(env, chatId, threadId, `❌ Не удалось прочитать файл: ${e.message}`);
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
      await sendT(env, chatId, threadId, full);
    } else {
      await sendT(env, chatId, threadId, header);
      await sendT(env, chatId, threadId, `<pre>${esc(display.slice(0, 3800))}</pre>`);
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
      await sendKbT(env, chatId, threadId,
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
        await sendT(env, chatId, threadId, '📭 Нет диалогов для архивирования.');
        return;
      }
      const buttons = list.map(s => ([{
        text: `${s.topic.slice(0, 32)} · ${timeAgo(s.lastAt)}`,
        callback_data: `sa:${s.id}`,
      }]));
      buttons.push([{ text: '← Отмена', callback_data: 'ar:menu' }]);
      await sendKbT(env, chatId, threadId,
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
      await sendT(env, chatId, threadId, `❌ Не удалось получить диалоги: ${e.message}`);
      return;
    }

    const toArchive = keepLast > 0 ? list.slice(keepLast) : list;
    if (toArchive.length === 0) {
      await sendT(env, chatId, threadId, '✅ Нечего архивировать — диалогов столько, сколько хочешь оставить.');
      return;
    }

    try {
      const result = await archiveSessions(env, {
        username: session.username,
        sessionIds: toArchive.map(s => s.id),
      });
      const n = result.archived ?? toArchive.length;
      await sendT(env, chatId, threadId, `✅ Архивировано диалогов: <b>${n}</b>`);
    } catch (e) {
      await sendT(env, chatId, threadId, `❌ Ошибка архивирования: ${e.message}`);
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
        await sendT(env, chatId, threadId, text);
      }
    } catch (e) {
      await sendT(env, chatId, threadId, `❌ Ошибка: ${e.message}`);
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
  if (['input_draft', 'input_run', 'input_journal'].includes(data?.split('|')[0])) {
    if (!session) { await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Войди: /login'); return; }
    if (env.EXECUTION_BACKEND === 'control-plane' && data.split('|')[0] === 'input_journal') {
      await answerCallbackQuery(env.BOT_TOKEN, id, 'Журнал Control Plane пока недоступен.');
      return;
    }
    await answerCallbackQuery(env.BOT_TOKEN, id);

    // «📜 Журнал» on a modern button already knows the session the agent ran on
    // (3rd part, input_journal|msg|sid) — the intake snapshot is only needed for
    // the legacy two-part buttons. Skipping the lookup here fixes the dead-end
    // where a tap on a card without an intake snapshot answered
    // «Для этого сообщения сохранённый input недоступен.» even though the
    // button carried everything needed to build the journal link. The snapshot
    // only held the id the gateway requested, which the agent may have healed
    // onto another session anyway (see b10b909) — the button id is the better one.
    if (data.split('|')[0] === 'input_journal') {
      const buttonSid = data.split('|')[2];
      if (buttonSid && /^[a-zA-Z0-9_.-]{1,128}$/.test(buttonSid)) {
        await sendJournalLink(env, chatId, threadId, { username: session.username, sessionId: buttonSid });
        return;
      }
    }

    if (!env.INTAKE) return;
    const stub = env.INTAKE.get(env.INTAKE.idFromName(conversationKey(chatId, threadId)));
    const params = new URLSearchParams({ messageId: data.split('|')[1] || String(message.message_id), username: session.username,
      draft: String(data === 'input_draft') });
    const response = await stub.fetch(`https://intake/input?${params}`);
    if (!response.ok) { await sendT(env, chatId, threadId, 'Для этого сообщения сохранённый input недоступен.'); return; }
    const input = await response.json();
    if (data.split('|')[0] === 'input_journal') {
      // Legacy two-part button: fall back to the snapshot id.
      const sid = input.body?.sessionId;
      if (!sid) { await sendT(env, chatId, threadId, 'Журнал появится после создания диалога.'); return; }
      await sendJournalLink(env, chatId, threadId, { username: session.username, sessionId: sid });
      return;
    }
    // Dispatched run: the REAL model input from the agent (system prompt +
    // context/task exactly as the engine received it, written at spawn time),
    // sent verbatim. A miss — not launched yet, old run, network — falls back
    // to the task text as-is. Either way the FILE is the input and nothing
    // else; the only context is the one-line caption (owner 29.09).
    if (input.state === 'snapshot' && env.EXECUTION_BACKEND !== 'control-plane') {
      const real = await fetchRunInput(env, input.body);
      if (real) {
        await sendDocument(env.BOT_TOKEN, chatId, 'agent-input.txt', real,
          `Реальный input агента — запуск ${input.id}`.slice(0, 900), threadId);
        return;
      }
    }
    const heading = env.EXECUTION_BACKEND === 'control-plane'
      ? (input.state === 'snapshot'
        ? `Зафиксированный ввод Control Plane — ${input.id}. Это не полный prompt модели.`
        : `Черновик ввода Control Plane (${(input.items || []).length} сообщ.${input.pending ? ', вложения обрабатываются' : ''}). Ещё не передан на определение интента.`)
      : input.state === 'snapshot'
      ? `Запуск ${input.id}: полный input агента не найден — в файле текст задачи, как ушёл агенту`
      : `Ещё не запущено (${(input.items || []).length} сообщ.${input.pending ? ', вложения обрабатываются' : ''}): в файле текст задачи. Полный input агента — этой кнопкой после запуска`;
    const document = renderSnapshotDocument(input);
    await sendDocument(env.BOT_TOKEN, chatId, 'input-snapshot.txt', document, heading.slice(0, 900), threadId);
    return;
  }

  if (data === 'intake_run' || data === 'intake_parallel' || /^ws\|(explore|answer|auto)\|\d+$/.test(data || '') || data?.startsWith('workrun|')) {
    const parallel = data === 'intake_parallel';
    const style = /^ws\|(explore|answer|auto)\|\d+$/.exec(data || '')?.[1] || null;
    if (!session) { await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Войди: /login'); return; }
    const launchAck = style === 'explore' ? '🧭 Изучу и задам вопросы…'
      : style === 'answer' ? '📝 Готовлю полный ответ…'
        : style === 'auto' ? '✨ Выбираю подходящий способ…'
          : parallel ? '⚡ Параллельно…' : '📨 Передаю задачу…';
    await answerCallbackQuery(env.BOT_TOKEN, id, launchAck);
    if (env.INTAKE) {
      const stub = env.INTAKE.get(env.INTAKE.idFromName(conversationKey(chatId, threadId)));
      const response = await stub.fetch('https://intake/flush', { method: 'POST', body: JSON.stringify({ parallel, ...callbackSource(cq, env, session) }) })
        .catch(err => { sendT(env, chatId, threadId, `❌ Ошибка: ${err.message}`); return null; });
      if (!response) return;
      if (env.EXECUTION_BACKEND === 'control-plane' && !response.ok) {
        await sendT(env, chatId, threadId, '⌛ Передача не подтверждена — используй текущее сообщение.');
        return;
      }
      const r = await response.json().catch(err => { sendT(env, chatId, threadId, `❌ Ошибка: ${err.message}`); return null; });
      // RC-03: an accepted parallel launch says so — it is a DIFFERENT claim
      // from «запущу после текущей» and must not reuse that wording.
      if (parallel && r?.parallel) {
        await sendT(env, chatId, threadId, '⚡ Запускаю параллельно — новая сессия, текущая задача не прерывается.');
        return;
      }
      // An empty buffer is a normal no-op after dispatch (including a stale
      // or duplicate tap). The callback is already acknowledged; don't add a
      // misleading instruction to resend a task that may already be running.
      // Busy/duplicate taps keep the existing status; the callback is already acknowledged.
      // A tap during a live run IS queued in the DO — say so, never a silent no-op.
      // `preparing` is the other `queued` — the attachment is still downloading, so
      // NOTHING is running: narrating «Идёт текущая задача» there is a lie (the DO
      // already sent its own honest «📥 Задачу забрал …» collector). #293.
      // The DO has already swapped ▶️ for «↩️ Отменить передачу агенту» on the
      // collector (launchQueued) — name that tail in the bubble so the two read
      // as one state (owner 29.09: «кнопка в любом случае будет и кейс более чёткий»).
      if (r?.queued && !r?.preparing) await sendT(env, chatId, threadId, '⏳ Идёт текущая задача. Запущу эти сообщения сразу после неё — жать ещё раз не нужно. Передумал — отменяй кнопкой «↩️ Отменить передачу агенту».');

    }
    return;
  }

  // ── Ф3 busy menu: stop options (RC-04 / RC-05, tg-bot#316) ──────────────────
  // «🛑 Стоп и запуск с добавкой» / «⛔ Стоп → новая задача» live on the RECEIPT
  // of the held input, not on the running task's message: that is where the user
  // actually decides what to do with the new input. Both are destructive, so the
  // tap only ASKS (SS-01) and the confirm does the stop + launch in one move.
  // The confirm bubble is its own message: the collector is owned by the DO and
  // re-renders itself on the stop — editing it would race that write.
  if (data === 'intake_stopsupp' || data === 'intake_stopnew') {
    const mode = data === 'intake_stopsupp' ? 'supp' : 'new';
    if (!session) { await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Войди: /login'); return; }
    let held = 0;
    if (env.INTAKE) {
      const stub = env.INTAKE.get(env.INTAKE.idFromName(conversationKey(chatId, threadId)));
      const r = await stub.fetch('https://intake/held').then(x => x.json()).catch(() => null);
      held = r?.items?.length || 0;
    }
    if (!held) {
      await answerCallbackQuery(env.BOT_TOKEN, id, '🤷 Порция уже передана — нечего запускать');
      await sendT(env, chatId, threadId, '🤷 Порция уже ушла агенту — запускать тут нечего.');
      return;
    }
    await answerCallbackQuery(env.BOT_TOKEN, id, mode === 'supp' ? '🛑 Стоп и запуск с добавкой…' : '⛔ Стоп → новая задача…');
    const ask = mode === 'supp'
      ? `🛑 Остановить текущую задачу и сразу продолжить её с этими ${held} сообщ. (тот же диалог, один запуск)?`
      : `⛔ Остановить текущую задачу и начать эти ${held} сообщ. НОВОЙ задачей?`;
    const confirmation = await sendKbT(env, chatId, threadId, ask, [[
      { text: '↩️ Вернуться', callback_data: `intake_stopno|${mode}` },
      { text: '⛔ Точно остановить', callback_data: `intake_stopyes|${mode}` },
    ]], { reply_to_message_id: message?.message_id, allow_sending_without_reply: true }, env);
    if (env.EXECUTION_BACKEND === 'control-plane') {
      const confirmationId = confirmation?.ok !== false && confirmation?.result?.message_id;
      let registered = false;
      if (Number.isSafeInteger(confirmationId) && confirmationId > 0) {
        try {
          const stub = env.INTAKE.get(env.INTAKE.idFromName(conversationKey(chatId, threadId)));
          const response = await stub.fetch('https://intake/callback-confirmation', { method: 'POST',
            body: JSON.stringify({ ...callbackSource(cq, env, session), messageId: confirmationId }) });
          registered = response.ok && (await response.json())?.owned === true;
        } catch { registered = false; }
      }
      if (!registered) {
        if (confirmationId) await editMessage(env.BOT_TOKEN, chatId, confirmationId,
          '⚠️ Подтверждение кнопки не сохранено — остановка не выполнялась.',
          { lifecycleEnv: env, reply_markup: { inline_keyboard: [] } }).catch(() => {});
        else await sendT(env, chatId, threadId, '⚠️ Подтверждение кнопки не получено — остановка не выполнялась.');
      }
    }
    return;
  }

  if (data?.startsWith('intake_stopyes|') || data?.startsWith('intake_stopno|')) {
    const mode = data.split('|')[1] === 'supp' ? 'supp' : 'new';
    const confirm = data.startsWith('intake_stopyes|');
    const msgId = message?.message_id;
    const close = text => msgId
      ? editMessage(env.BOT_TOKEN, chatId, msgId, text, { lifecycleEnv: env, reply_markup: { inline_keyboard: [] } }).catch(() => {})
      : null;
    if (!session) { await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Войди: /login'); return; }
    if (!confirm) {
      await answerCallbackQuery(env.BOT_TOKEN, id, '↩️ Отменено — задача продолжает работать.');
      await close('↩️ Остановка отменена — задача продолжает работать.');
      return;
    }
    await answerCallbackQuery(env.BOT_TOKEN, id, '⛔ Останавливаю…');
    await close('⛔ Останавливаю задачу…');
    // Same honest stop as /stop and the ⛔ button: hold the intake queue, cancel
    // queued delivery and kill the chain. Supplement launches remain gated on
    // confirmation; stop-new is an explicit independent task if stopping fails.
    const result = await stopChat(env, { username: session.username, chatId, threadId, ...callbackSource(cq, env, session) });
    if (result.error && !(mode === 'new' && env.EXECUTION_BACKEND === 'control-plane')) {
      console.warn('[stop-launch] stop not confirmed:', result.error.message);
      await close(result.killed
        ? '⚠️ Агент не подтвердил завершение задачи — добавку не запускал, чтобы не задвоить работу.'
        : '⚠️ Не удалось подтвердить остановку — порцию не запускал. Задача может продолжать работу.');
      return;
    }
    const stopUnconfirmed = !!(result.error && mode === 'new' && env.EXECUTION_BACKEND === 'control-plane');
    const sessionId = session.activeSessionId || session.lastSessionId;
    const route = mode === 'supp' ? { sessionId, forceNew: false, projectId: session.projectId || null,
      projectChosen: true, projectPicked: false, newProject: false, contextFromSession: null } : null;
    const r = env.INTAKE
      ? await env.INTAKE.get(env.INTAKE.idFromName(conversationKey(chatId, threadId)))
        .fetch('https://intake/stop-launch', { method: 'POST', body: JSON.stringify({ mode, route, ...callbackSource(cq, env, session) }) })
        .then(x => x.json()).catch(err => { console.error('[stop-launch]', err.message); return null; })
      : null;
    if (r?.already) {
      await close('⏳ Уже выполняется — порция уйдёт одним запуском.');
      return;
    }
    if (r?.nothing) {
      await close('🤷 Порция уже передана — запускать тут нечего.');
      return;
    }
    const what = mode === 'supp' ? 'продолжу её с твоими сообщениями' : 'запущу их новой задачей';
    await close(stopUnconfirmed
      ? '⚠️ Остановка старой задачи не подтверждена. Порция запускается отдельной задачей; старая может продолжить работу.'
      : r?.waiting
      ? `⛔ Задача остановлена. Как только остановка подтвердится — ${what}.`
      : `⛔ Задача уже завершалась. ${mode === 'supp' ? 'Продолжаю её' : 'Запускаю'} с твоими сообщениями.`);
    return;
  }

  // «↩️ Отменить передачу агенту» — the tail left in place of ▶️ once a tap is
  // remembered (issue #305). Clears the queue in the DO; the DO itself re-renders
  // the collector with ▶️ back (single owner of that message — no edit from here,
  // so the two writes can't race). Stopping a RUNNING task is /tasks/stop, not this.
  if (data === 'intake_cancel') {
    if (!session) { await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Войди: /login'); return; }
    await answerCallbackQuery(env.BOT_TOKEN, id, '↩️ Отменяю передачу…');
    if (env.INTAKE) {
      const stub = env.INTAKE.get(env.INTAKE.idFromName(conversationKey(chatId, threadId)));
      const response = await stub.fetch('https://intake/cancel', { method: 'POST',
        ...(env.EXECUTION_BACKEND === 'control-plane' ? { body: JSON.stringify(callbackSource(cq, env, session)) } : {}) })
        .catch(err => { sendT(env, chatId, threadId, `❌ Ошибка: ${err.message}`); return null; });
      if (!response) return;
      if (env.EXECUTION_BACKEND === 'control-plane' && !response.ok) {
        await sendT(env, chatId, threadId, '⌛ Отмена передачи не подтверждена — используй текущее сообщение.');
        return;
      }
      const r = await response.json().catch(err => { sendT(env, chatId, threadId, `❌ Ошибка: ${err.message}`); return null; });
      if (r?.cancelled) await sendT(env, chatId, threadId, r?.stopLaunchCancelled
        ? '↩️ Передача отменена — сообщения остались в порции. Задача при этом осталась остановленной: запустить порцию можно кнопкой в меню.'
        : '↩️ Передача отменена — сообщения остались в порции. Когда будешь готов, запускай кнопкой.');
    }
    return;
  }

  if (/^intake_discard\|\d+$/.test(data || '')) {
    if (!session) { await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Войди: /login'); return; }
    await answerCallbackQuery(env.BOT_TOKEN, id, '🗑 Сбрасываю эту порцию…');
    if (!env.INTAKE) return;
    const stub = env.INTAKE.get(env.INTAKE.idFromName(conversationKey(chatId, threadId)));
    const response = await stub.fetch('https://intake/discard', { method: 'POST',
      body: JSON.stringify(callbackSource(cq, env, session)) }).catch(() => null);
    if (!response?.ok) {
      await sendT(env, chatId, threadId, '⌛ Не получилось безопасно сбросить порцию: запуск уже проверяется или принят. Текущая задача не затронута.');
      return;
    }
    const result = await response.json().catch(() => ({}));
    if (result.discarded) await sendT(env, chatId, threadId,
      `🗑 Порция сброшена (${result.count} сообщ.). Текущая задача не затронута — можно отправить новую.`);
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
    const thinkMsg = await sendT(env, chatId, threadId, '▶️ Продолжаю по плану…');
    const initialMsgId = thinkMsg?.result?.message_id ?? null;
    await runTask(env, {
      initiatedAt, threadId: threadId,
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
    }).catch(err => sendT(env, chatId, threadId, `❌ Ошибка: ${err.message}`));
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
    const thinkMsg = await sendT(env, chatId, threadId, '🔎 Разбираюсь подробнее…');
    const initialMsgId = thinkMsg?.result?.message_id ?? null;
    await runTask(env, {
      initiatedAt, threadId: threadId,
      requestId: `callback-${id}`,
      userId: chatId,
      username: session.username,
      sessionId,
      forceClaude: true,
      mode: 'deep',
      initialMsgId,
      telegramUserId: session.telegramUserId,
      projectId: session.projectId || null,
    }).catch(err => sendT(env, chatId, threadId, `❌ Ошибка: ${err.message}`));
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
    // Compatibility for already-sent menus incorrectly generated from the GTD
    // footer. Resolve the actual tapped button, never guess from its index.
    const tapped = message?.reply_markup?.inline_keyboard?.flat().find(b => b.callback_data === data);
    const label = String(tapped?.text || '').replace(/^\d+\.\s*/, '').trim();
    const checklistCommand = /^Отключить чеклист$/i.test(label) ? '/checklist_turn_off'
      : /^Чеклист активен$/i.test(label) ? '/show_active_cheklist' : null;
    if (checklistCommand) {
      await answerCallbackQuery(env.BOT_TOKEN, id);
      await runTask(env, {
        initiatedAt, threadId: threadId,
        requestId: `callback-${id}`, userId: chatId, username: session.username,
        sessionId, task: checklistCommand, forceClaude: false,
        telegramUserId: session.telegramUserId, projectId: session.projectId || null,
      }).catch(err => sendT(env, chatId, threadId, `❌ Ошибка: ${err.message}`));
      return;
    }

    await answerCallbackQuery(env.BOT_TOKEN, id, `▶️ Вариант ${optionNo}…`);
    const thinkMsg = await sendT(env, chatId, threadId, `▶️ Продолжаю с вариантом ${optionNo}…`);
    const initialMsgId = thinkMsg?.result?.message_id ?? null;
    await runTask(env, {
      initiatedAt, threadId: threadId,
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
    }).catch(err => sendT(env, chatId, threadId, `❌ Ошибка: ${err.message}`));
    return;
  }

  // ── Extracted action buttons (#1542 P3) ─────────────────────────────────────
  // act|{sessionId}|{idx} — the agent's post-processor pulled concrete actions out
  // of its own answer («Создать PR», «Задеплоить») and rendered one button each.
  // The label on the tapped button IS the instruction: we read it back from the
  // message markup (no sidecar, no callback_data bytes spent on text) and run it
  // in the same session, deep. The tap itself is the user's consent to that action.
  if (data?.startsWith('act|')) {
    if (!session) { await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Войди: /login'); return; }
    const rest = data.slice('act|'.length);
    const sepIdx = rest.lastIndexOf('|');
    const sessionId = (sepIdx === -1 ? rest : rest.slice(0, sepIdx)) || session.activeSessionId || session.lastSessionId;
    const tapped = message?.reply_markup?.inline_keyboard?.flat().find(b => b.callback_data === data);
    const label = String(tapped?.text || '').replace(/^▶️\s*/, '').trim();
    if (!label) { await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Кнопка устарела — напиши текстом'); return; }
    await answerCallbackQuery(env.BOT_TOKEN, id, `▶️ ${label}`.slice(0, 190));
    const thinkMsg = await sendT(env, chatId, threadId, `▶️ ${label}…`);
    const initialMsgId = thinkMsg?.result?.message_id ?? null;
    await runTask(env, {
      initiatedAt, threadId: threadId,
      requestId: `callback-${id}`,
      userId: chatId,
      username: session.username,
      sessionId,
      task: `[Пользователь нажал кнопку «${label}» под твоим последним ответом. Выполни именно это действие так, как ты его описал выше, и доведи до конца. Не переспрашивай — согласие уже дано нажатием кнопки.]`,
      forceClaude: true,
      mode: 'deep',
      initialMsgId,
      telegramUserId: session.telegramUserId,
      projectId: session.projectId || null,
    }).catch(err => sendT(env, chatId, threadId, `❌ Ошибка: ${err.message}`));
    return;
  }

  // ── Forgotten checklist (#1729 BV-08/08a) ─────────────────────────────────
  // ocl|do|<id> «▶️ Делать» — start the orphaned checklist's continuation as its own
  // background run; ocl|no|<id> «✖️ Отменить» — cancel it, never remind again. Sent by the
  // agent's GTD tick (one reminder) and by /all_forgotten_checklists. The agent route is
  // deterministic (no LLM); we edit the tapped message to its outcome and drop the buttons.
  if (data?.startsWith('ocl|')) {
    if (!session) { await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Войди: /login'); return; }
    const [, action, oclId] = data.split('|');
    if ((action !== 'do' && action !== 'no') || !oclId) { await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Кнопка устарела'); return; }
    let out;
    try {
      out = await orphanChecklistAction(env, { username: session.username, action, id: oclId, chatId, threadId });
    } catch (err) {
      await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Агент недоступен — попробуй позже');
      return;
    }
    const text = String(out?.text || (action === 'do' ? '▶️ Взял в работу' : '✖️ Отменено'));
    await answerCallbackQuery(env.BOT_TOKEN, id, text.slice(0, 190));
    const msgId = message?.message_id;
    const html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    if (msgId) await editMessage(env.BOT_TOKEN, chatId, msgId, html, { lifecycleEnv: env, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    else await sendT(env, chatId, threadId, text);
    return;
  }

  // ── Stop task button (⛔ Стоп, sent by agent on task start) ─────────────────
  // stop|{taskId} — first tap only shows a confirm keyboard (↩️ Вернуться /
  // ⛔ Точно остановить); the actual stop only happens on the explicit stopok|
  // tap below (stopno| cancels back). Same confirm-before-destructive shape as
  // the supok|/supno| supplement flow — a stray/rushed tap can no longer kill
  // a running task.
  if (data?.startsWith('stop|')) {
    if (!session) { await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Войди: /login'); return; }
    const taskId = data.slice('stop|'.length);
    await answerCallbackQuery(env.BOT_TOKEN, id);
    const msgId = message?.message_id;
    const confirmText = '⛔ Точно остановить задачу?';
    const confirmKeyboard = [[
      { text: '↩️ Вернуться', callback_data: `stopno|${taskId}` },
      { text: '⛔ Точно остановить', callback_data: `stopok|${taskId}` },
    ]];
    if (msgId) await editMessage(env.BOT_TOKEN, chatId, msgId, confirmText, { lifecycleEnv: env, reply_markup: { inline_keyboard: confirmKeyboard } }).catch(() => {});
    else await sendKbT(env, chatId, threadId, confirmText, confirmKeyboard, {}, env);
    return;
  }

  // ── Stop confirmation (⛔ Точно остановить / ↩️ Вернуться) ───────────────────
  // stopok|{taskId} — explicit confirm, actually stops the task.
  // stopno|{taskId} — cancels, task keeps running.
  if (data?.startsWith('stopok|') || data?.startsWith('stopno|')) {
    if (!session) { await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Войди: /login'); return; }
    const confirm = data.startsWith('stopok|');
    const msgId = message?.message_id;
    if (!confirm) {
      await answerCallbackQuery(env.BOT_TOKEN, id, '↩️ Отменено — задача продолжает работать.');
      if (msgId) await editMessage(env.BOT_TOKEN, chatId, msgId, '↩️ Остановка отменена — задача продолжает работать.', { lifecycleEnv: env, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      return;
    }
    await answerCallbackQuery(env.BOT_TOKEN, id, '⛔ Останавливаю…');
    // #1856: same path as /stop — hold the intake queue first, then kill the run.
    const result = await stopChat(env, { username: session.username, chatId, threadId, ...callbackSource(cq, env, session) });
    const text = env.EXECUTION_BACKEND === 'control-plane' && !result.killed
      ? '⚠️ Остановка задачи не подтверждена.' : stopReplyText(result, { button: true });
    if (result.error && result.killed === 0 && (result.held || result.hadIntent)) {
      console.warn('[stop] agent stop failed after intake hold:', result.error.message);
    }
    if (msgId) await editMessage(env.BOT_TOKEN, chatId, msgId, text, { lifecycleEnv: env, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    else await sendT(env, chatId, threadId, text);
    return;
  }

  // ── Supplement running task (➕ Дополнить, sent by agent alongside ⛔ Стоп) ──
  // sup|{taskId} arms a collector in the conversation's IntakeBuffer DO
  // (src/lib/supplement.js): routeText diverts the next messages — text, voice,
  // files — into ONE draft and shows a single confirmation bubble. Nothing is
  // stopped by the typed text alone; only the explicit supok| tap below does it
  // (supno| cancels). Scenario: agent docs/user-scenarios/core/02-stop-and-supplement.md.
  if (data?.startsWith('sup|')) {
    if (!session) { await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Войди: /login'); return; }
    const taskId = data.slice('sup|'.length);
    const sessionId = session.activeSessionId || session.lastSessionId;
    if (!sessionId) { await answerCallbackQuery(env.BOT_TOKEN, id, '🤷 Нет активной сессии'); return; }
    const armed = await armSupplement(env, chatId, threadId, { taskId, sessionId, expiresAt: Date.now() + PICKER_TTL_MS })
      .catch(e => { console.error('[supplement] arm failed:', e.message); return false; });
    if (!armed) { await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Не получилось — нажми «Дополнить» ещё раз'); return; }
    await answerCallbackQuery(env.BOT_TOKEN, id, '✏️ Напиши, что добавить');
    await sendT(env, chatId, threadId,
      '✏️ Напиши дополнение следующим сообщением (можно несколько, голосом или файлом) — потом спрошу, перезапустить ли задачу с ним.');
    return;
  }

  // ── Supplement confirmation (➕ Перезапуск с дополнением / ↩️ Вернуться) ────
  // The draft is TAKEN atomically from the DO, so a double tap can't launch twice.
  // supno| and an expired draft hand the collected messages back to the ordinary
  // intake flow — the user's words are never dropped (K5).
  if (data?.startsWith('supok|') || data?.startsWith('supno|')) {
    if (!session) { await answerCallbackQuery(env.BOT_TOKEN, id, '⚠️ Войди: /login'); return; }
    const confirm = data.startsWith('supok|');
    const msgId = message?.message_id;
    const draft = await takeSupplement(env, chatId, threadId).catch(() => null);
    const closeBubble = text => msgId
      ? editMessage(env.BOT_TOKEN, chatId, msgId, text, { lifecycleEnv: env, reply_markup: { inline_keyboard: [] } }).catch(() => {})
      : null;
    if (!draft?.items?.length) {
      await answerCallbackQuery(env.BOT_TOKEN, id, '🤷 Черновик дополнения не найден — нажми «Дополнить» заново.');
      if (msgId) await editMessageReplyMarkup(env.BOT_TOKEN, chatId, msgId, []).catch(() => {});
      return;
    }
    if (!confirm || Date.now() >= draft.expiresAt) {
      await releaseToIntake(env, chatId, threadId, draft.items);
      const why = confirm ? '⌛ Черновик устарел' : '✖️ Дополнение отменено';
      await answerCallbackQuery(env.BOT_TOKEN, id, `${why} — задача не тронута.`);
      await closeBubble(`${why} — задача продолжает работать. Написанное вернул во входящие: запустить его можно кнопкой «▶️ Запустить агента».`);
      return;
    }
    await answerCallbackQuery(env.BOT_TOKEN, id, '➕ Проверяю остановку…');
    await closeBubble('➕ Проверяю остановку перед перезапуском…');
    let stopped;
    try {
      stopped = await stopTask(env, { username: session.username, chatId, threadId });
    } catch (error) {
      await releaseToIntake(env, chatId, threadId, draft.items);
      await closeBubble('⚠️ Не удалось подтвердить остановку. Дополнение вернул во входящие — новый запуск не выполнял, повторно нажимать не нужно.');
      await answerCallbackQuery(env.BOT_TOKEN, id, 'Остановка не подтверждена');
      console.error('[supplement] stop failed:', error.message);
      return;
    }
    if (stopped?.confirmed !== true && stopped?.stopConfirmed !== true) {
      await releaseToIntake(env, chatId, threadId, draft.items);
      await closeBubble('⚠️ Остановка не подтверждена — дополнение вернул во входящие, новый запуск не выполнял.');
      await answerCallbackQuery(env.BOT_TOKEN, id, 'Остановка не подтверждена');
      return;
    }
    await answerCallbackQuery(env.BOT_TOKEN, id, stopped?.stopped === false
      ? 'Предыдущая задача уже завершилась — запускаю продолжение'
      : 'Остановка подтверждена — запускаю дополнение');
    await closeBubble(stopped?.stopped === false
      ? '✅ Предыдущая задача уже завершилась. Запускаю дополнение как продолжение в том же диалоге — повторно нажимать не нужно.'
      : '✅ Остановка подтверждена. Запускаю дополнение в том же диалоге — повторно нажимать не нужно.');
    // Preserve voice and file messages through the ordinary intake handler. The
    // stop response is checked first, so an unconfirmed old run cannot overlap.
    const base = draft.items.at(-1).msg;
    const note = '[Дополнение к задаче — продолжай с учётом этих сообщений:]';
    const header = { text: note, msg: { chat: base.chat, text: note } };
    const { handleMessage } = await import('./message.js');
    return handleMessage({ ...base, intakeItems: [header, ...draft.items],
      intakeRoute: { sessionId: draft.sessionId, forceNew: false, projectId: session.projectId || null,
        projectChosen: true, projectPicked: false, newProject: false, contextFromSession: null } },
    env, { mode: 'deep', forceClaude: true, initialMsgId: msgId || null, initiatedAt,
      requestId: `sup-${draft.taskId}-${msgId || id}` })
      .catch(err => sendT(env, chatId, threadId, `❌ Ошибка запуска дополнения: ${err.message}`));
  }

  await answerCallbackQuery(env.BOT_TOKEN, id);
}
