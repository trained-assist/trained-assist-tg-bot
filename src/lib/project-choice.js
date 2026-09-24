import { getProjectDecision, runTask } from './agent-client.js';
import { getSession, setSession, newSessionId, withKvConsistencyRetry } from './kv.js';
import { sendMessage, sendMessageWithKeyboard, editMessage, answerCallbackQuery } from './telegram.js';
import { PICKER_TTL_MS, trackUI, projectChoiceExpired } from './transient-ui.js';
import { shouldAskProject } from '../intake-routing.js';
import { mirrorPicker } from './picker-mirror.js';
import { threadExtra, threadIdOf } from '../conversation-context.js';

const PAGE_SIZE = 6;
const esc = value => String(value).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// First human line of the captured task, so the picker can PROVE the message
// wasn't lost. `input` is either a raw Telegram message or a merged batch with
// intakeItems (text / caption / voice transcript).
function capturedPreview(input) {
  if (!input) return '';
  const items = input.intakeItems
    ? input.intakeItems.map(i => i?.text || i?.msg?.text || i?.msg?.caption || i?.msg?.transcript || '')
    : [input.text || input.caption || input.transcript || ''];
  const line = items.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return line ? (line.length > 120 ? `${line.slice(0, 120)}…` : line) : '';
}

async function render(env, chatId, pending, page = 0, threadId = null) {
  const start = page * PAGE_SIZE;
  const choices = pending.choices.slice(start, start + PAGE_SIZE);
  // Copy MUST reflect state: when the task is already captured we never tell the
  // user to «write your task» — that dead-ended a real user who had already sent
  // it (owner, 2026-09-22). Selecting a project dispatches the captured task.
  const preview = capturedPreview(pending.input);
  const hasTask = !!pending.input;
  const header = hasTask
    ? '📂 <b>Задача уже принята — выбери проект, и сразу запущу проработку.</b>'
    : '📂 <b>В какой проект работаем?</b>';
  // Pinned chat, but the agent is confident the task is about another project → say
  // why we ask instead of binding silently (suggested is choice 1, pinned is choice 2).
  const mm = pending.mismatch;
  const nameOf = id => { const p = pending.choices.find(c => c.id === id); return esc(String(p?.name || p?.label || id).slice(0, 80)); };
  const mismatchLine = mm ? [`🤔 Похоже, задача про «${nameOf(mm.suggested)}», а чат закреплён за «${nameOf(mm.pinned)}». Закреп не изменится.`, ''] : [];
  const text = [header, '', ...mismatchLine,
    ...(preview ? [`<i>принято:</i> ${esc(preview)}`, ''] : []),
    ...choices.map((p, i) => {
      const summary = p.summary?.end || p.summary?.middle || '';
      return `${start + i + 1}. <b>${esc(String(p.name || p.label || p.id).slice(0, 80))}</b>` +
        (summary ? `\n${esc(String(summary).slice(0, 180))}` : '');
    })].join('\n');
  const rows = [choices.map((_, i) => ({ text: String(start + i + 1), callback_data: `pc:${start + i}` }))].filter(r => r.length);
  const nav = [];
  if (page > 0) nav.push({ text: '← Назад', callback_data: `pc:page:${page - 1}` });
  if (start + PAGE_SIZE < pending.choices.length) nav.push({ text: 'Дальше →', callback_data: `pc:page:${page + 1}` });
  if (nav.length) rows.push(nav);
  rows.push([{ text: '➕ Новый проект', callback_data: 'pc:new' }]);
  rows.push([{ text: '🔀 Переструктурировать проекты', callback_data: 'pc:reorg' }]);
  if (pending.messageId) {
    await editMessage(env.BOT_TOKEN, chatId, pending.messageId, text,
      { lifecycleEnv: env, reply_markup: { inline_keyboard: rows } });
    await trackUI(env, chatId, pending.messageId, rows, pending.createdAt);
    return pending.messageId;
  }
  const sent = await sendMessageWithKeyboard(env.BOT_TOKEN, chatId, text, rows, { ...threadExtra(threadId) }, env);
  if (!sent?.result?.message_id) throw new Error('Не удалось показать выбор проекта');
  await trackUI(env, chatId, sent.result.message_id, rows, pending.createdAt);
  return sent.result.message_id;
}

// Persist Telegram references, never base64 payloads; media can be reloaded after
// selection. Indices refer to this snapshot, not a freshly sorted server list.
export async function openProjectChoice(env, chatId, session, { decision, input = null, opts = {}, contextFromSession = null, threadId = null } = {}) {
  decision ||= await getProjectDecision(env, { username: session.username, chatId, task: input?.text || input?.caption || '' });
  const previous = session.pendingProjectChoice?.input;
  if (previous) contextFromSession ||= session.pendingProjectChoice.contextFromSession;
  if (previous && input) {
    const items = m => m.intakeItems || [{ text: m.text || m.caption || '', msg: m }];
    input = { ...input, intakeItems: [...items(previous), ...items(input)] };
  } else if (previous) {
    input = previous;
    opts = session.pendingProjectChoice.opts;
  }
  const pending = { choices: decision.choices || [], createdAt: Date.now(), expiresAt: Date.now() + PICKER_TTL_MS, token: crypto.randomUUID(), input,
    opts, contextFromSession, messageId: null, mismatch: decision.mismatch || null };
  await setSession(env.SESSIONS, chatId, { ...session, pendingProjectChoice: pending }, threadId);
  const messageId = await render(env, chatId, pending, 0, threadId);
  if (input && opts.initialMsgId) {
    await editMessage(env.BOT_TOKEN, chatId, opts.initialMsgId, '📂 Задача сохранена. Выбери проект в меню ниже.',
      { reply_markup: { inline_keyboard: [] } }).catch(() => {});
  }
  await mirrorPicker(env, chatId, { ...pending, messageId }, threadId);
  const current = await getSession(env.SESSIONS, chatId, threadId);
  if (current?.pendingProjectChoice?.token === pending.token) {
    await setSession(env.SESSIONS, chatId, { ...current, pendingProjectChoice: { ...pending, messageId } }, threadId);
  }
}

// «✨ Новый диалог» (nd:, /new_dialog, sn:) — same rule as the plain-message path:
// ask /project-decision and show the picker ONLY for action 'ask'. A chat with a
// pinned project (or a single project) gets action 'auto' → bind it silently (#1318).
// The bound id is NOT an explicit choice, so projectPicked stays false (no re-pin).
export async function startNewDialog(env, chatId, session, { contextFromSession = null, threadId = null } = {}) {
  const decision = await getProjectDecision(env, { username: session.username, chatId, task: '' });
  if (session.pendingProjectChoice?.input || shouldAskProject({ isNewDialog: true, decision })) {
    return openProjectChoice(env, chatId, session, { decision, contextFromSession, threadId });
  }
  const project = decision.action === 'auto'
    ? (decision.choices || []).find(c => c.id === decision.pinned) || decision.choices?.[0] || decision.project || null
    : null;
  const sessionId = newSessionId(chatId);
  await setSession(env.SESSIONS, chatId, { ...session,
    pendingProjectChoice: null, pendingMessage: null, pendingMessageAt: null,
    activeSessionId: sessionId, activeSessionIsNew: true, lastSessionId: null,
    projectId: project?.id || null, projectSelectionSessionId: sessionId, projectPicked: false,
    pendingNewProject: false, contextFromSession: contextFromSession || null }, threadId);
  const label = project ? `📁 ${esc(project.name || project.label || project.id)}\n\n` : '';
  await sendMessage(env.BOT_TOKEN, chatId, `${label}✨ Новый диалог — напиши свою задачу!`, { ...threadExtra(threadId) });
}

export async function chooseProject(cq, env, session) {
  const chatId = cq.message.chat.id;
  const threadId = threadIdOf(cq.message);
  session = await withKvConsistencyRetry(env.SESSIONS, chatId, session,
    s => { const p = s?.pendingProjectChoice; return !!p && !projectChoiceExpired(p, cq); }, 400, threadId);
  const pending = session?.pendingProjectChoice;
  if (!pending || projectChoiceExpired(pending, cq)) {
    await answerCallbackQuery(env.BOT_TOKEN, cq.id, '⌛ Открой «Новый диалог» заново.');
    return;
  }
  const raw = cq.data.slice(3);
  if (/^page:\d+$/.test(raw)) {
    const page = Number(raw.slice(5));
    await answerCallbackQuery(env.BOT_TOKEN, cq.id);
    if (page * PAGE_SIZE < pending.choices.length) await render(env, chatId, pending, page, threadId);
    return;
  }
  // «🔀 Переструктурировать проекты» — standalone action, not a project pick. Any
  // task text captured for this picker is dropped (user explicitly chose reorg
  // over continuing it); dispatches straight to reproject_preview via Claude
  // (agent/src/mcp-skills/tools/06-reproject.js), which never moves anything
  // without an explicit reproject_apply({confirm:true}).
  if (raw === 'reorg') {
    await answerCallbackQuery(env.BOT_TOKEN, cq.id, '🔀 Запускаю переструктурирование…');
    await editMessage(env.BOT_TOKEN, chatId, pending.messageId,
      '🔀 <b>Переструктурирование проектов</b>\n\nСмотрю текущую структуру и предложу план — без подтверждения ничего не изменится.',
      { lifecycleEnv: env, reply_markup: { inline_keyboard: [] } });
    await setSession(env.SESSIONS, chatId, { ...session, pendingProjectChoice: null }, threadId);
    await mirrorPicker(env, chatId, null, threadId);
    await runTask(env, {
      userId: chatId,
      threadId,
      username: session.username,
      sessionId: newSessionId(chatId),
      forceNew: true,
      forceClaude: true,
      mode: 'deep',
      telegramUserId: session.telegramUserId,
      task: '[Пользователь нажал «🔀 Переструктурировать проекты» в меню выбора проекта. Вызови reproject_preview, покажи получившийся план переструктурирования пользователю и явно спроси подтверждение — применяй (reproject_apply({confirm:true})) только после его согласия.]',
    }).catch(err => sendMessage(env.BOT_TOKEN, chatId, `❌ Ошибка: ${err.message}`, { ...threadExtra(threadId) }));
    return;
  }
  const project = /^\d+$/.test(raw) ? pending.choices[Number(raw)] : null;
  if (!project && raw !== 'new') {
    await answerCallbackQuery(env.BOT_TOKEN, cq.id, 'Проект не найден');
    return;
  }
  // projectPicked: the user explicitly chose an existing project in the menu → the agent
  // pins the chat to it (#1318). «➕ Новый проект» pins via newProjectName instead.
  // Exception: a mismatch prompt (pinned chat, task looked like another project) is a
  // one-off detour — the chosen project binds this session only, the pin stays.
  const route = { sessionId: newSessionId(chatId), forceNew: true, projectChosen: true,
    projectId: project?.id || null, projectPicked: !!project && !pending.mismatch, newProject: raw === 'new', contextFromSession: pending.contextFromSession };
  await setSession(env.SESSIONS, chatId, { ...session,
    pendingProjectChoice: pending.input ? { ...pending, dispatching: true } : null, pendingMessage: null, pendingMessageAt: null, pendingPickerId: null, pendingOriginalMessage: null, pendingOriginalOpts: null,
    activeSessionId: route.sessionId, activeSessionIsNew: true, lastSessionId: null,
    projectId: route.projectId, projectSelectionSessionId: route.sessionId, projectPicked: route.projectPicked,
    pendingNewProject: route.newProject, contextFromSession: route.contextFromSession }, threadId);
  // Consume the mirror before dispatch so a second tap can't launch the task twice.
  await mirrorPicker(env, chatId, null, threadId);
  await answerCallbackQuery(env.BOT_TOKEN, cq.id);
  const label = project ? `📁 ${esc(project.name || project.label)}` : '➕ Новый проект — название определим по задаче';
  await editMessage(env.BOT_TOKEN, chatId, pending.messageId,
    `${label}\n\n${pending.input ? '📨 Передаю сохранённую задачу…' : 'Пиши задачу: можно добавить текст, голос и файлы, затем запустить проработку.'}`,
    { lifecycleEnv: env, reply_markup: { inline_keyboard: [] } });
  if (pending.input) {
    const { handleMessage } = await import('../handlers/message.js');
    try {
      await handleMessage({ ...pending.input, intakeRoute: route }, env, { ...pending.opts, intakeRoute: route });
      const current = await getSession(env.SESSIONS, chatId, threadId);
      if (current?.pendingProjectChoice?.messageId === pending.messageId) {
        await setSession(env.SESSIONS, chatId, { ...current, pendingProjectChoice: null }, threadId);
      }
    } catch (err) {
      const current = await getSession(env.SESSIONS, chatId, threadId);
      if (current?.pendingProjectChoice?.messageId === pending.messageId) {
        await setSession(env.SESSIONS, chatId, { ...current, pendingProjectChoice: pending }, threadId);
        await mirrorPicker(env, chatId, pending, threadId);
        await render(env, chatId, pending, 0, threadId);
      }
      await sendMessage(env.BOT_TOKEN, chatId, '⚠️ Не удалось подготовить задачу. Сообщения сохранены — выбери проект ещё раз, чтобы повторить.', { ...threadExtra(threadId) });
    }
  }
}
