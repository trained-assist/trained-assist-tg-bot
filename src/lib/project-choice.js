import { getProjectDecision } from './agent-client.js';
import { getSession, setSession, newSessionId, withKvConsistencyRetry } from './kv.js';
import { sendMessage, sendMessageWithKeyboard, editMessage, answerCallbackQuery } from './telegram.js';
import { PICKER_TTL_MS, trackUI, projectChoiceExpired } from './transient-ui.js';

const PAGE_SIZE = 6;
const esc = value => String(value).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

async function render(env, chatId, pending, page = 0) {
  const start = page * PAGE_SIZE;
  const choices = pending.choices.slice(start, start + PAGE_SIZE);
  const text = ['📂 <b>В какой проект добавить новый диалог?</b>', '',
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
  if (pending.messageId) {
    await editMessage(env.BOT_TOKEN, chatId, pending.messageId, text,
      { lifecycleEnv: env, reply_markup: { inline_keyboard: rows } });
    await trackUI(env, chatId, pending.messageId, rows, pending.createdAt);
    return pending.messageId;
  }
  const sent = await sendMessageWithKeyboard(env.BOT_TOKEN, chatId, text, rows, {}, env);
  if (!sent?.result?.message_id) throw new Error('Не удалось показать выбор проекта');
  await trackUI(env, chatId, sent.result.message_id, rows, pending.createdAt);
  return sent.result.message_id;
}

// Persist Telegram references, never base64 payloads; media can be reloaded after
// selection. Indices refer to this snapshot, not a freshly sorted server list.
export async function openProjectChoice(env, chatId, session, { decision, input = null, opts = {}, contextFromSession = null } = {}) {
  decision ||= await getProjectDecision(env, { username: session.username, chatId });
  const previous = session.pendingProjectChoice?.input;
  if (previous) contextFromSession ||= session.pendingProjectChoice.contextFromSession;
  if (previous && input) {
    const items = m => m.intakeItems || [{ text: m.text || m.caption || '', msg: m }];
    input = { ...input, intakeItems: [...items(previous), ...items(input)] };
  } else if (previous) {
    input = previous;
    opts = session.pendingProjectChoice.opts;
  }
  const pending = { choices: decision.choices || [], createdAt: Date.now(), token: crypto.randomUUID(), input,
    opts, contextFromSession, messageId: null };
  await setSession(env.SESSIONS, chatId, { ...session, pendingProjectChoice: pending });
  const messageId = await render(env, chatId, pending);
  if (input && opts.initialMsgId) {
    await editMessage(env.BOT_TOKEN, chatId, opts.initialMsgId, '📂 Задача сохранена. Выбери проект в меню ниже.',
      { reply_markup: { inline_keyboard: [] } }).catch(() => {});
  }
  const current = await getSession(env.SESSIONS, chatId);
  if (current?.pendingProjectChoice?.token === pending.token) {
    await setSession(env.SESSIONS, chatId, { ...current, pendingProjectChoice: { ...pending, messageId } });
  }
}

export async function chooseProject(cq, env, session) {
  const chatId = cq.message.chat.id;
  session = await withKvConsistencyRetry(env.SESSIONS, chatId, session,
    s => !projectChoiceExpired(s?.pendingProjectChoice, cq));
  const pending = session?.pendingProjectChoice;
  if (projectChoiceExpired(pending, cq)) {
    await answerCallbackQuery(env.BOT_TOKEN, cq.id, '⌛ Открой «Новый диалог» заново.');
    return;
  }
  const raw = cq.data.slice(3);
  if (/^page:\d+$/.test(raw)) {
    const page = Number(raw.slice(5));
    await answerCallbackQuery(env.BOT_TOKEN, cq.id);
    if (page * PAGE_SIZE < pending.choices.length) await render(env, chatId, pending, page);
    return;
  }
  const project = /^\d+$/.test(raw) ? pending.choices[Number(raw)] : null;
  if (!project && raw !== 'new') {
    await answerCallbackQuery(env.BOT_TOKEN, cq.id, 'Проект не найден');
    return;
  }
  const route = { sessionId: newSessionId(chatId), forceNew: true, projectChosen: true,
    projectId: project?.id || null, newProject: raw === 'new', contextFromSession: pending.contextFromSession };
  await setSession(env.SESSIONS, chatId, { ...session,
    pendingProjectChoice: pending.input ? { ...pending, dispatching: true } : null, pendingMessage: null, pendingMessageAt: null, pendingPickerId: null, pendingOriginalMessage: null, pendingOriginalOpts: null,
    activeSessionId: route.sessionId, activeSessionIsNew: true, lastSessionId: null,
    projectId: route.projectId, projectSelectionSessionId: route.sessionId,
    pendingNewProject: route.newProject, contextFromSession: route.contextFromSession });
  await answerCallbackQuery(env.BOT_TOKEN, cq.id);
  const label = project ? `📁 ${esc(project.name || project.label)}` : '➕ Новый проект — название определим по задаче';
  await editMessage(env.BOT_TOKEN, chatId, pending.messageId,
    `${label}\n\n${pending.input ? '📨 Передаю сохранённую задачу…' : 'Пиши задачу: можно добавить текст, голос и файлы, затем запустить проработку.'}`,
    { lifecycleEnv: env, reply_markup: { inline_keyboard: [] } });
  if (pending.input) {
    const { handleMessage } = await import('../handlers/message.js');
    try {
      await handleMessage({ ...pending.input, intakeRoute: route }, env, { ...pending.opts, intakeRoute: route });
      const current = await getSession(env.SESSIONS, chatId);
      if (current?.pendingProjectChoice?.messageId === pending.messageId) {
        await setSession(env.SESSIONS, chatId, { ...current, pendingProjectChoice: null });
      }
    } catch (err) {
      const current = await getSession(env.SESSIONS, chatId);
      if (current?.pendingProjectChoice?.messageId === pending.messageId) {
        await setSession(env.SESSIONS, chatId, { ...current, pendingProjectChoice: pending });
        await render(env, chatId, pending);
      }
      await sendMessage(env.BOT_TOKEN, chatId, '⚠️ Не удалось подготовить задачу. Сообщения сохранены — выбери проект ещё раз, чтобы повторить.');
    }
  }
}
