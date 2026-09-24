import { readMedia } from '../lib/media-retry.js';
import { PICKER_TTL_MS } from '../lib/transient-ui.js';
import { enqueueRecovery } from '../retry-queue.js';
import { shouldAskProject } from '../intake-routing.js';
import { openProjectChoice } from '../lib/project-choice.js';
import { Buffer } from 'node:buffer';
import { prepareIntake } from '../intake-preflight.js';
import { sendMessage, sendMessageWithKeyboard, sendDocument } from '../lib/telegram.js';
import { getSession, setSession, newSessionId, takeDueRetries, markRetryStarted, finishRetry, saveRetryOutcome } from '../lib/kv.js';
import { runTask, getSessions, classifyMessage, getProjectDecision, classifyAgentError, stopTask } from '../lib/agent-client.js';
import { renderSessionList, escHtml, timeAgo } from './commands.js';
import commandsRegistry from '../../commands-registry.json';

// Phrases that signal "start a new session" regardless of history
const NEW_SESSION_SIGNALS = [
  'другой вопрос', 'другая задача', 'новая задача', 'новый вопрос',
  'по другому', 'другая тема', 'смени тему', 'начни с нуля', 'начнём с нуля',
  'новая тема', 'забудь про', 'new task', 'new session', 'другое:',
];

// /bug_or_feature (+ aliases, from commands-registry.json — the same source
// AGENT_FORWARDED_COMMANDS in commands.js reads) ALWAYS opens a fresh session bound
// to the agent's reserved bugs-and-features project (BUGS-AND-FEATURES-SPEC §3.4),
// never continues whatever the chat's last regular session was. Paired with
// BUG_OR_FEATURE_INTENT in the agent's intent-engine.js, which honors the fresh
// sessionId minted below for the session it creates — without this, the gateway's
// lastSessionId stays pointed at the old session and every buffered follow-up after
// ▶️ launches into the wrong place, disconnected from the bugs project entirely.
const BUG_OR_FEATURE_COMMANDS = new Set(
  (commandsRegistry.commands.find(c => c.command === '/bug_or_feature')?.aliases || [])
    .concat('/bug_or_feature')
    .map((c) => c.toLowerCase())
);

// Sessions newer than this are continued automatically without classify or confirmation.
// 1h is recent enough to assume continuity; beyond that the topic may have shifted.
const RECENT_SESSION_THRESHOLD_MS = 1 * 60 * 60 * 1000; // 1 hour

// Telegram's Bot API cloud servers refuse getFile above this size — it's a
// platform limit, not something we can raise from the worker side.
const MAX_TG_DOWNLOAD_BYTES = 20 * 1024 * 1024;

function tooBigMessage(fileSize) {
  const mb = fileSize ? (fileSize / (1024 * 1024)).toFixed(1) : '20+';
  return `⚠️ Файл слишком большой (${mb} MB). Telegram не отдаёт ботам файлы крупнее 20 MB через getFile — это ограничение самого Telegram, обойти его на нашей стороне нельзя.\n\nЧто можно сделать:\n• Сожми видео при отправке (Telegram делает это сам, если выбрать более низкое качество)\n• Пришли только звук (голосовым) — этого обычно достаточно для транскрипта\n• Загрузи файл на Google Drive/Диск и пришли ссылку`;
}

export async function handleMessage(msg, env, opts = {}) {
  const { chat, text, voice, audio, photo, document: doc, video } = msg;
  const chatId = chat.id;
  const ids = msg.intakeItems?.map(i => i.msg?.message_id).filter(Boolean) || [msg.message_id].filter(Boolean);
  if (ids.length && !opts.requestId) {
    const bytes = new TextEncoder().encode(`${chatId}:${ids.join(',')}`);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    opts = { ...opts, requestId: `tg-${Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')}` };
  }

  let session = await getSession(env.SESSIONS, chatId);
  if (!session) {
    return sendMessage(env.BOT_TOKEN, chatId,
      '👋 Сначала войди: /login username password'
    );
  }

  // Consume a one-shot «➕ Дополнить» flow (sup| in callbacks.js): the next plain-text
  // message is stashed as a DRAFT on the session and a confirmation keyboard
  // (✅ Перезапустить / ❌ Отменить) is shown. The actual stop+restart happens only on
  // an explicit supok| tap in callbacks.js — a stray or rushed text message can no
  // longer kill a running task. Only plain text counts — media/batched intake items
  // fall through to normal handling untouched.
  if (session.pendingSupplementDraft && (msg.text || '').trim() && !msg.intakeItems) {
    const { taskId, sessionId, expiresAt } = session.pendingSupplementDraft;
    session = { ...session, pendingSupplementDraft: null };
    if (Date.now() < expiresAt) {
      const draft = { taskId, sessionId, text: msg.text, expiresAt: Date.now() + PICKER_TTL_MS };
      await setSession(env.SESSIONS, chatId, { ...session, pendingSupplementDraft: draft });
      await sendMessageWithKeyboard(env.BOT_TOKEN, chatId,
        '➕ Остановить текущую задачу и перезапустить её с твоим дополнением?',
        [[
          { text: '↩️ Вернуться', callback_data: `supno|${taskId}` },
          { text: '➕ Перезапуск с дополнением', callback_data: `supok|${taskId}` },
        ]], {}, env);
      return;
    }
    // Expired — draft dropped, fall through to normal handling of this message.
    await setSession(env.SESSIONS, chatId, session);
  }

  try {
    if (msg.intakeItems) {
      const items = [];
      // Sequential uploads bound peak memory for old cached batches and large media.
      for (const item of msg.intakeItems) items.push({ ...item, msg: await prepareIntake({ chat: msg.chat, ...item.msg }, env, session) });
      msg = { ...msg, intakeItems: items };
    } else {
      msg = await prepareIntake(msg, env, session);
    }
  } catch (error) {
    throw Object.assign(new Error(error?.message || 'Attachment preparation failed', { cause: error }), { code: 'INTAKE_PREPARATION_FAILED' });
  }

  // prepareIntake already notified the user for oversized files; skip agent dispatch.
  if (msg.fileTooLarge) return;
  if (msg.intakeItems) {
    const validItems = msg.intakeItems.filter(i => !i.msg?.fileTooLarge);
    if (!validItems.length) return;
    msg = { ...msg, intakeItems: validItems };
  }

  const route = opts.intakeRoute || msg.intakeRoute ||
    await resolveSessionRoute(chatId, session, msg.text || msg.caption || '', env);
  const chosen = route.projectChosen || session.projectSelectionSessionId === route.sessionId;
  const pendingPickerExpired = !!session.pendingProjectChoice?.expiresAt && Date.now() >= session.pendingProjectChoice.expiresAt;
  if (pendingPickerExpired) {
    const current = await getSession(env.SESSIONS, chatId);
    if (current?.pendingProjectChoice) {
      await setSession(env.SESSIONS, chatId, { ...current, pendingProjectChoice: null });
    }
  }
  const pendingCreation = !pendingPickerExpired && !!session.pendingProjectChoice && !session.pendingProjectChoice.suspended && !route.projectChosen;
  if (pendingCreation || ((route.forceNew || (!session.lastSessionId && route.type !== 'disambiguate')) && !chosen)) {
    const decision = await getProjectDecision(env, { username: session.username, chatId, task: msg.text || msg.caption || '' });
    if (decision.action !== 'quick' && (pendingCreation || shouldAskProject({ isNewDialog: true, decision }))) {
      await openProjectChoice(env, chatId, session, { decision, input: msg,
        opts: { mode: opts.mode || null, initialMsgId: opts.initialMsgId || null },
        contextFromSession: route.contextFromSession || session.contextFromSession || null });
      return;
    }
    // Quick command detected: clear any stuck pending project choice so the next real
    // task doesn't re-trigger the picker.
    if (decision.action === 'quick' && pendingCreation) {
      const current = await getSession(env.SESSIONS, chatId);
      if (current?.pendingProjectChoice) {
        await setSession(env.SESSIONS, chatId, { ...current, pendingProjectChoice: null });
      }
    }
  }
  opts = { ...opts, initiatedAt: opts.initiatedAt ?? (Number.isFinite(msg.date) ? msg.date * 1000 : Date.now()), intakeRoute: opts.intakeRoute || msg.intakeRoute, resolvedRoute: route, originalMessage: msg };

  const items = msg.intakeItems || [{ text: msg.text || msg.caption || '', msg }];
  const prepared = items.map((item, index) => {
    const m = item.msg;
    const caption = stripMediaTags(item.text || m.text || m.caption || '');
    return { text: [caption, m.transcript,
      m.fileRef ? `Вложение ${index + 1}: ${m.fileRef.name}` : ''].filter(Boolean).join('\n'),
      refs: [m.fileRef, m.transcriptRef].filter(Boolean), isVoice: !!m.transcript };
  });
  const task = msg.intakeItems ? prepared.map((p, i) => `[Сообщение ${i + 1}]\n${p.text}`).join('\n\n') : prepared[0].text;
  return handleText(chatId, session, task, env, { ...opts,
    requestId: opts.requestId || (items.every(i => i.msg.message_id)
      ? `intake-${await batchIdentity(chatId, items)}` : crypto.randomUUID()),
    fileRefs: prepared.flatMap(p => p.refs), isVoice: prepared.some(p => p.isVoice),
    durableInput: !!(msg.intakeItems || opts.intakeRoute || msg.intakeRoute),
  });
}

async function batchIdentity(chatId, items) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${chatId}:${items.map(i => i.msg.message_id).join(',')}`));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}

// Strip coalesced media tag-lines ("photo:<id>", "voice:<id>", …) that
// IntakeBuffer._dispatch injects, leaving only the human-typed text.
function stripMediaTags(text) {
  if (!text) return '';
  return text
    .split('\n')
    .filter(line => !/^(photo|voice|audio|document|video):/i.test(line.trim()))
    .join('\n')
    .trim();
}

async function handleText(chatId, session, text, env, opts = {}) {
  let retryOpts = opts;
  let accepted = false;
  try {
    const route = opts.resolvedRoute || opts.intakeRoute || await resolveSessionRoute(chatId, session, text, env);

    if (route.type === 'disambiguate') {
      // Store the pending message, show session picker
      await setSession(env.SESSIONS, chatId, {
        ...session,
        pendingPickerId: null,
        pendingMessage: text,
        pendingMessageAt: Date.now(),
        pendingOriginalMessage: opts.originalMessage || null,
        pendingOriginalOpts: { mode: opts.mode || null, initialMsgId: opts.initialMsgId || null },
      });
      const picker = await sendDisambiguationKeyboard(env.BOT_TOKEN, chatId, route.sessions, session.activeSessionId, env);
      if (picker?.result?.message_id) {
        const current = await getSession(env.SESSIONS, chatId);
        if (current?.pendingMessage === text) await setSession(env.SESSIONS, chatId, { ...current, pendingPickerId: picker.result.message_id });
      }
      return;
    }

    if (route.type === 'confirm-stale') {
      // Session was classified as matching but is stale — ask the user to confirm
      // before running. Stores pending message so the sp: callback can dispatch it.
      await setSession(env.SESSIONS, chatId, {
        ...session,
        pendingPickerId: null,
        pendingMessage: text,
        pendingMessageAt: Date.now(),
        pendingOriginalMessage: opts.originalMessage || null,
        pendingOriginalOpts: { mode: opts.mode || null, initialMsgId: opts.initialMsgId || null },
      });
      await sendStaleSessionConfirm(env.BOT_TOKEN, chatId, route.session, route.sessionAge, env);
      return;
    }

    // Run the task — agent creates/continues session
    const sessionId = route.sessionId;
    retryOpts = { ...opts, resolvedRoute: route, retryUsername: session.username, durableInput: false,
      intakeRoute: { ...route, projectId: route.projectChosen ? route.projectId : (opts.intakeRoute?.projectId ?? session.projectId ?? null),
        contextFromSession: opts.intakeRoute?.contextFromSession ?? session.contextFromSession ?? null } };
    const context = opts.isVoice ? '[voice-message]' : null;

    // Use caller-supplied placeholder if provided (e.g. from doc handler), otherwise send our own.
    const placeholderRes = opts.initialMsgId
      ? null
      : await sendMessage(env.BOT_TOKEN, chatId, '📨 Передаю задачу агенту…');
    const initialMsgId = opts.initialMsgId ?? (placeholderRes?.result?.message_id ?? null);

    // Pass existing pinnedMsgId to agent — agent manages its content (skills, context, etc.)
    // If agent creates a new pinned message it returns the new ID; we store it for next time
    const result = await runTask(env, {
      initiatedAt: opts.initiatedAt, threadId: opts.originalMessage?.message_thread_id || null,
      userId: chatId,
      requestId: opts.requestId,
      username: session.username,
      task: text,
      context,
      sessionId,
      forceNew: !!route.forceNew,
      contextFromSession: opts.intakeRoute ? (opts.intakeRoute.contextFromSession || null) : (session.contextFromSession || null),
      mode: opts.mode || null,
      initialMsgId,
      pinnedMsgId: session.pinnedMsgId || null,
      telegramUserId: session.telegramUserId,
      projectId: route.projectChosen ? route.projectId : (opts.intakeRoute ? opts.intakeRoute.projectId : (session.projectId || null)),
      newProjectName: route.forceNew && (route.newProject || (session.projectSelectionSessionId === route.sessionId && session.pendingNewProject))
        ? text.replace(/^\[Сообщение \d+\]\s*/u, '').split('\n')[0].trim().slice(0, 60) || 'Новый проект' : null,
      requestId: opts.requestId,
      fileRefs: opts.fileRefs || [],
      fileBase64: opts.fileBase64 || null,
      fileName: opts.fileName || null,
      fileMimeType: opts.fileMimeType || null,
    });

    accepted = true;
    const newPinnedMsgId = result?.pinnedMsgId || session.pinnedMsgId || null;

    await setSession(env.SESSIONS, chatId, {
      ...session,
      lastSessionId: sessionId,
      lastMessageAt: Date.now(),
      pendingMessage: null,
      pendingMessageAt: null,
      pendingOriginalMessage: null,
      pendingOriginalOpts: null,
      activeSessionId: null,
      activeSessionIsNew: null,
      projectSelectionSessionId: null,
      pendingNewProject: false,
      contextFromSession: null,
      pinnedMsgId: newPinnedMsgId,
    });
    if (opts.isRetry) return { outcome: 'accepted', notice: `✅ Попытка восстановления ${opts.retryAttempt}/2: агент принял задачу.` };
  } catch (err) {
    // Telegram/session bookkeeping failures after ACK must never resubmit work.
    if (accepted) {
      console.warn('[recovery] accepted, bookkeeping failed:', err.message);
      return { outcome: 'accepted', notice: `✅ Попытка восстановления ${opts.retryAttempt}/2: агент принял задачу.` };
    }
    if (env.RUN_OUTBOX) throw err;
    // R10: a 15s timeout ≠ agent down. Probe /health to tell "busy" from "down"
    // so we never falsely tell the user to resend (which spawns a duplicate session).
    const kind = await classifyAgentError(env, err);

    if (opts.durableInput && kind !== 'down') throw err;
    const attempt = opts.retryAttempt || 0;
    const reason = kind === 'down' ? 'сервер агента недоступен'
      : kind === 'busy' ? 'сервер отвечает, но подтверждение приёма не пришло'
      : 'ошибка при передаче задачи';
    console.warn(`[recovery] chat=${chatId} attempt=${attempt} kind=${kind} error=${err.message}`);
    if (kind === 'down' && attempt < 2 && !opts.fileBase64) {
      try {
        await enqueueRecovery(env, { chatId, text, opts: { ...retryOpts, retryAttempt: attempt } });
      } catch (queueError) {
        console.error('[recovery] enqueue failed', queueError.message);
        if (opts.durableInput) throw queueError;
        const notice = `⚠️ Восстановление не запланировано: ${reason}; не удалось сохранить повтор в очередь. Нужен ручной запуск.`;
        if (opts.isRetry) return { outcome: 'queue_failed', notice };
        await sendMessage(env.BOT_TOKEN, chatId, notice);
        return 'queue_failed';
      }
      const notice = attempt
        ? `⚠️ Попытка восстановления ${attempt}/2 не удалась: ${reason}. Следующая попытка через 3 минуты.`
        : '⏸ Агент временно недоступен. Попробую снова через 3 минуты (до двух попыток) — не отправляй повторно.';
      if (opts.isRetry) return { outcome: 'scheduled', notice };
      await sendMessage(env.BOT_TOKEN, chatId, notice).catch(e => console.warn('[recovery] queued notification failed:', e.message));
      return 'scheduled';
    }
    const userMsg = opts.isRetry
      ? `⚠️ Попытка восстановления ${attempt}/2 не удалась: ${reason}. ${kind === 'busy' ? 'Запрос мог быть принят; повторять автоматически не буду, чтобы не создать дубль.' : 'Автоповторы остановлены.'}`
      : kind === 'busy'
      ? '↪️ Сервер отвечает, но подтверждение приёма задачи не пришло. Пока не отправляй повторно: запрос мог быть принят.'
      : kind === 'down'
      ? '⏸ Агент временно недоступен. Файл не удалось поставить на автоповтор; попробуй прислать его ещё раз через пару минут.'
      : `❌ Ошибка: ${reason}`;
    if (opts.isRetry) return { outcome: kind, notice: userMsg };
    await sendMessage(env.BOT_TOKEN, chatId, userMsg);
    return kind;
  }
}

async function recoveryNotice(env, chatId, text) {
  const result = await sendMessage(env.BOT_TOKEN, chatId, text);
  if (!result?.ok) throw new Error(`Recovery notification rejected: ${result?.description || 'unknown'}`);
}

export async function processDueRetries(env) {
  if (env.RETRY_QUEUE && !env.RECOVERY_STORE) {
    const stub = env.RETRY_QUEUE.get(env.RETRY_QUEUE.idFromName('recovery'));
    const response = await stub.fetch('https://recovery/drain', { method: 'POST' });
    if (!response.ok) throw new Error(`Recovery drain HTTP ${response.status}`);
    return;
  }
  const store = env.RECOVERY_STORE || env.SESSIONS;
  const due = await takeDueRetries(store);
  for (const entry of due) {
    const { chatId, text, opts = {} } = entry;
    try {
      let result = entry.terminal;
      if (!result) {
        const session = await getSession(env.SESSIONS, chatId);
        if (!session || (opts.retryUsername && opts.retryUsername !== session.username)) {
          result = { outcome: 'profile_changed', notice: '⚠️ Восстановление отменено: вход в профиль завершён или выбран другой профиль.' };
        } else if (entry.startedAt) {
          result = { outcome: 'outcome_unknown', notice: '⚠️ Попытка восстановления прервалась без подтверждённого результата. Задача могла быть принята; автоматический повтор остановлен, чтобы не создать дубль.' };
        } else {
          const attempt = (opts.retryAttempt || 0) + 1;
          await recoveryNotice(env, chatId, `🔄 Пробую восстановить сессию: попытка ${attempt}/2.`);
          await markRetryStarted(store, entry);
          result = await handleText(chatId, session, text, env, { ...opts, initialMsgId: null, isRetry: true, retryAttempt: attempt });
          result ||= { outcome: 'awaiting_choice', notice: '↪️ Для восстановления нужно выбрать диалог.' };
        }
        await saveRetryOutcome(store, entry, result);
      }
      await recoveryNotice(env, chatId, result.notice);
      await finishRetry(store, entry, result.outcome);
    } catch (err) {
      console.error(`[recovery] chat=${chatId} worker failed:`, err.message);
      // Keep the entry: a later cron reports an interrupted attempt. One broken
      // chat must not prevent recovery attempts for all other due entries.
    }
  }
}

/**
 * Decide what to do with the incoming message:
 *   { type: 'run', sessionId }           — run task with this session
 *   { type: 'disambiguate', sessions }   — show session picker first
 */
async function resolveSessionRoute(chatId, session, text, env) {
  const lc = text.toLowerCase();
  if (session.activeSessionId && session.projectSelectionSessionId === session.activeSessionId) {
    return { type: 'run', sessionId: session.activeSessionId, forceNew: true, projectChosen: true,
      projectId: session.projectId || null, newProject: !!session.pendingNewProject,
      contextFromSession: session.contextFromSession || null };
  }

  // 0.5 /bug_or_feature (+ aliases) — always a fresh session, see BUG_OR_FEATURE_COMMANDS above.
  const firstWord = text.split(' ')[0].split('@')[0].toLowerCase();
  if (BUG_OR_FEATURE_COMMANDS.has(firstWord)) {
    const newId = newSessionId(chatId);
    return { type: 'run', sessionId: newId, forceNew: true };
  }

  // 1. Explicit new-session signal in text → new session
  if (NEW_SESSION_SIGNALS.some(s => lc.includes(s))) {
    const newId = newSessionId(chatId);
    return { type: 'run', sessionId: newId, forceNew: true };
  }

  // 2. User explicitly chose a session via /sessions button → use it once, then clear.
  // activeSessionIsNew: set by the "sn:" callback (new dialog with carried-over context) —
  // that id is a freshly generated one with no file on disk yet, so it needs forceNew too,
  // or the sign-split heal would silently reattach it to the chat's old pointer.
  if (session.activeSessionId) {
    return { type: 'run', sessionId: session.activeSessionId, forceNew: !!session.activeSessionIsNew };
  }

  // 3. No history at all → new session
  if (!session.lastSessionId) {
    const newId = newSessionId(chatId);
    return { type: 'run', sessionId: newId, forceNew: true };
  }

  // 3.5 Slash commands are quick-actions / explicit bot commands — never show
  // the session picker. They don't carry conversational context so disambiguation
  // adds friction without value. Always route to the last known session.
  if (text.startsWith('/')) {
    return { type: 'run', sessionId: session.lastSessionId };
  }

  // 4. Recent session (< 2h) → continue it automatically, no friction
  if (session.lastMessageAt && (Date.now() - session.lastMessageAt) < RECENT_SESSION_THRESHOLD_MS) {
    return { type: 'run', sessionId: session.lastSessionId };
  }

  // 5. Last session is old — fetch session list and ask Claude Haiku to classify
  let recentSessions;
  try {
    recentSessions = await getSessions(env, { username: session.username, limit: 5 });
  } catch {
    // Agent unreachable — just continue last session
    return { type: 'run', sessionId: session.lastSessionId };
  }

  // Only 1 session → continue it (no need to classify)
  if (!recentSessions || recentSessions.length <= 1) {
    return { type: 'run', sessionId: session.lastSessionId };
  }

  // Multiple sessions → ask Claude Haiku which one this message belongs to
  let classification = { sessionId: null, confidence: 'low' };
  try {
    classification = await classifyMessage(env, { message: text, sessions: recentSessions });
  } catch { /* fallback to picker */ }

  if (classification.confidence === 'high' && classification.sessionId) {
    // Clear match — route automatically, user won't notice any friction
    return { type: 'run', sessionId: classification.sessionId };
  }

  if (classification.confidence === 'medium' && classification.sessionId) {
    // Session matched but is stale (>1h) — show a 2-button lightweight confirm
    // instead of the full picker. The user either taps "continue" (reuses sp: handler)
    // or taps "new" without having to read through a full session list.
    const matched = recentSessions.find(s => s.id === classification.sessionId);
    return { type: 'confirm-stale', session: matched, sessionAge: classification.sessionAge };
  }

  // Ambiguous — show picker with all recent sessions
  return { type: 'disambiguate', sessions: recentSessions.slice(0, 4) };
}

// New-dialog project picker (issue #517). Uses the project INDEX in callback_data
// (pp:<i>) — typed project ids can be long Cyrillic slugs that blow the 64-byte
// callback_data limit. The pp: handler re-fetches the list and looks up by index
// (same ordering as GET /project-decision → listProjects, most-used first, i.e.
// highest session count — recency only breaks ties. Both /project-decision and
// /projects must sort identically or the index lookup here resolves to the wrong project.)
export async function sendProjectPicker(botToken, chatId, choices, activeId, env) {
  // Descriptive body + numbered tap-buttons — same shape as the session picker
  // (renderSessionList). A project carries a durable 3-sense summary (start/middle/end)
  // from the agent; render it so the user can tell projects apart, instead of a bare
  // name button. Falls back to name-only when the summary hasn't matured yet.
  const list = choices.slice(0, 8);
  const lines = ['📂 <b>В какой проект работаем?</b>', '', 'Выбери номер проекта ниже:', ''];
  list.forEach((c, i) => {
    const n = i + 1;
    const name = c.name || c.label || 'Без названия';
    const active = c.id === activeId ? ' ✅' : '';
    const tag = c.type && c.type !== 'generic' && c.label ? ` · ${escHtml(c.label)}` : '';
    lines.push(`<b>${n}. ${escHtml(name.slice(0, 80))}</b>${tag}${active}`);
    const s = c.summary || {};
    if (s.start)  lines.push(`▫️ старт: ${escHtml(String(s.start).slice(0, 160))}`);
    if (s.middle) lines.push(`▫️ в процессе: ${escHtml(String(s.middle).slice(0, 220))}`);
    if (s.end)    lines.push(`▫️ сейчас: ${escHtml(String(s.end).slice(0, 160))}`);
    const meta = [];
    if (c.lastAt) meta.push(`🕒 ${timeAgo(c.lastAt)}`);
    if (typeof c.sessionCount === 'number' && c.sessionCount > 0) meta.push(`${c.sessionCount} диал.`);
    if (meta.length) lines.push(meta.join(' · '));
    lines.push('');
  });
  const numBtns = list.map((c, i) => ({ text: String(i + 1), callback_data: `pp:${i}` }));
  const rows = [];
  for (let i = 0; i < numBtns.length; i += 5) rows.push(numBtns.slice(i, i + 5));
  rows.push([{ text: '➕ Новый проект', callback_data: 'pp:new' }]);
  return sendMessageWithKeyboard(botToken, chatId, lines.join('\n').trim(), rows, {}, env);
}

// Lightweight 2-button confirmation for stale-but-classified sessions.
// Reuses the sp: callback handler (same as full picker taps) — no new callback type.
async function sendStaleSessionConfirm(botToken, chatId, session, sessionAge, env) {
  const topic = session?.topic ? escHtml(session.topic.slice(0, 40)) : 'прошлый диалог';
  const ago = sessionAge ? timeAgo(Date.now() - sessionAge) : '';
  const text = `↩ Продолжаем «${topic}»${ago ? ` (${ago})` : ''}?`;
  const buttons = [[
    { text: '✅ Да, продолжить', callback_data: `sp:${session.id}` },
    { text: '✨ Новый диалог', callback_data: 'sp:new' },
  ]];
  return sendMessageWithKeyboard(botToken, chatId, text, buttons, {}, env);
}

async function sendDisambiguationKeyboard(botToken, chatId, sessions, activeId, env) {
  // Descriptive text body (project · title · gist · meta) + numbered tap-buttons,
  // same renderer as /sessions and the new-dialog context picker. Replaces the old
  // 28-char truncated button labels that made dialogs indistinguishable.
  const { text, buttons } = renderSessionList(sessions, {
    callbackPrefix: 'sp',
    header: '↩ <b>В какой диалог добавить сообщение?</b>',
    hint: 'Выбери номер диалога ниже:',
  });
  buttons.push([{ text: '✨ Новый диалог', callback_data: 'sp:new' }]);

  return sendMessageWithKeyboard(botToken, chatId, text, buttons, {}, env);
}

function transcriptPreview(text, maxSentences = 3) {
  const sentences = [];
  let remaining = text;
  for (let i = 0; i < maxSentences && remaining.length > 0; i++) {
    const m = remaining.match(/^[^.!?]*[.!?]+\s*/);
    if (!m) { sentences.push(remaining.trimEnd()); break; }
    sentences.push(m[0].trim());
    remaining = remaining.slice(m[0].length);
  }
  return sentences.join(' ');
}

// Shared by voice/audio and video/video-as-document branches: transcribe via
// Deepgram (it accepts video containers directly — no local extraction needed),
// deliver the transcript to the chat, then hand it to the agent as the task text.
async function transcribeAndDispatch(chatId, session, env, opts, humanCaption, fileId, mimeType, emoji) {
  const { transcript, error } = await transcribeVoice(fileId, mimeType, env);
  if (!transcript) {
    await sendMessage(env.BOT_TOKEN, chatId, `❌ Транскрипция не удалась: ${error}`);
    return;
  }
  if (transcript.length < 800) {
    await sendMessage(env.BOT_TOKEN, chatId, `${emoji} ${transcript}`);
  } else {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const filename = `transcript-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}.txt`;
    const preview = transcriptPreview(transcript, 3);
    await sendDocument(env.BOT_TOKEN, chatId, filename, transcript, `${emoji} ${preview}…`);
  }
  // Prepend any accumulated human text so buffered "текст + медиа" keeps both.
  const task = humanCaption ? `${humanCaption}\n${transcript}` : transcript;
  await handleText(chatId, session, task, env, { ...opts, isVoice: true, mode: opts.mode || null });
}

export async function transcribeVoice(fileId, mimeType, env) {
  const tgBase = (env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
  const fileData = await readMedia(
    `${tgBase}/bot${env.BOT_TOKEN}/getFile?file_id=${fileId}`
  );
  if (!fileData.ok) {
    return { transcript: null, error: `getFile failed: ${JSON.stringify(fileData)}` };
  }

  // File download always goes through api.telegram.org/file/ — use same proxy base
  const audioUrl = `${tgBase}/file/bot${env.BOT_TOKEN}/${fileData.result.file_path}`;
  const audioBuffer = await readMedia(audioUrl, {}, 'arrayBuffer', 120000);

  const dgText = await readMedia(
    'https://api.deepgram.com/v1/listen?model=nova-2&language=ru&smart_format=true',
    {
      method: 'POST',
      headers: {
        'Authorization': `Token ${env.DEEPGRAM_API_KEY}`,
        'Content-Type': mimeType || 'audio/ogg; codecs=opus',
      },
      body: audioBuffer,
    }, 'text', 120000
  );
  const dgData = JSON.parse(dgText);
  const transcript = dgData?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
  if (!transcript) {
    const confidence = dgData?.results?.channels?.[0]?.alternatives?.[0]?.confidence;
    return { transcript: null, error: `empty transcript (size: ${audioBuffer.byteLength}b, confidence: ${confidence})` };
  }
  return { transcript, error: null };
}

const DOWNLOAD_TIMEOUT_MS = 20_000;

export async function downloadTgFileBase64(fileId, env) {
  const tgBase = (env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
  const fileRes = await fetch(`${tgBase}/bot${env.BOT_TOKEN}/getFile?file_id=${fileId}`, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  const fileData = await fileRes.json();
  if (!fileData.ok) return { base64: null, error: `getFile failed: ${JSON.stringify(fileData)}` };

  const fileUrl = `${tgBase}/file/bot${env.BOT_TOKEN}/${fileData.result.file_path}`;
  const fileRes2 = await fetch(fileUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!fileRes2.ok) return { base64: null, error: `download ${fileRes2.status}` };

  const buffer = await fileRes2.arrayBuffer();
  // nodejs_compat gives us a real Buffer — native base64 encoding. The previous
  // char-by-char String.fromCharCode loop was CPU-bound O(n) JS on the isolate's
  // wall/CPU-time budget; on a real phone photo it could blow the limit and get
  // silently killed mid-flight (this runs under waitUntil, so no exception ever
  // surfaces to the user — exactly the "Запускаю…" then nothing, forever" hang).
  return { base64: Buffer.from(buffer).toString('base64'), error: null };
}
