import { shouldAskProject } from '../intake-routing.js';
import { openProjectChoice } from '../lib/project-choice.js';
import { Buffer } from 'node:buffer';
import { packAttachments } from '../lib/attachment-bundle.js';
import { sendMessage, sendMessageWithKeyboard, sendDocument } from '../lib/telegram.js';
import { getSession, setSession, newSessionId, scheduleRetry, takeDueRetries } from '../lib/kv.js';
import { runTask, getSessions, classifyMessage, getProjectDecision, classifyAgentError } from '../lib/agent-client.js';
import { renderSessionList, escHtml, timeAgo } from './commands.js';

// Phrases that signal "start a new session" regardless of history
const NEW_SESSION_SIGNALS = [
  'другой вопрос', 'другая задача', 'новая задача', 'новый вопрос',
  'по другому', 'другая тема', 'смени тему', 'начни с нуля', 'начнём с нуля',
  'новая тема', 'забудь про', 'new task', 'new session', 'другое:',
];

const RECENT_SESSION_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours

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

  const session = await getSession(env.SESSIONS, chatId);
  if (!session) {
    return sendMessage(env.BOT_TOKEN, chatId,
      '👋 Сначала войди: /login username password'
    );
  }

  const route = opts.intakeRoute || msg.intakeRoute ||
    await resolveSessionRoute(chatId, session, msg.text || msg.caption || '', env);
  const chosen = route.projectChosen || session.projectSelectionSessionId === route.sessionId;
  const pendingCreation = !!session.pendingProjectChoice && !session.pendingProjectChoice.suspended && !route.projectChosen;
  if (pendingCreation || ((route.forceNew || (!session.lastSessionId && route.type !== 'disambiguate')) && !chosen)) {
    const decision = await getProjectDecision(env, { username: session.username, chatId });
    if (pendingCreation || shouldAskProject({ isNewDialog: true, decision })) {
      await openProjectChoice(env, chatId, session, { decision, input: msg,
        opts: { mode: opts.mode || null, initialMsgId: opts.initialMsgId || null },
        contextFromSession: route.contextFromSession || session.contextFromSession || null });
      return;
    }
  }
  opts = { ...opts, resolvedRoute: route, originalMessage: msg, intakeOwned: !!msg.intakeItems };

  if (msg.intakeItems) {
    // Resolve EVERY original message before making the single agent request.
    // Parallel I/O preserves array order while avoiding N sequential STT waits.
    const prepared = await Promise.all(msg.intakeItems.map(async (item, index) => {
      const m = item.msg || {};
      const caption = item.text || m.text || m.caption || '';
      const media = m.voice || m.audio || m.video ||
        (m.document && /^(audio|video)\//i.test(m.document.mime_type || '') ? m.document : null);
      const file = m.photo?.[m.photo.length - 1] || m.document;
      if ((media || file)?.file_size > MAX_TG_DOWNLOAD_BYTES) {
        throw new Error(`Сообщение ${index + 1}: файл больше 20 MB`);
      }
      if (media) {
        const { transcript, error } = m.transcript
          ? { transcript: m.transcript }
          : await transcribeVoice(media.file_id, media.mime_type || null, env);
        if (!transcript) throw new Error(`Сообщение ${index + 1}: ${error || 'пустая расшифровка'}`);
        return { text: [caption, transcript].filter(Boolean).join('\n'), isVoice: true };
      }
      if (file) {
        const cached = m.attachmentKey ? await env.SESSIONS.get(m.attachmentKey, { type: 'json' }) : null;
        const { base64, error } = cached || await downloadTgFileBase64(file.file_id, env);
        if (error) throw new Error(`Сообщение ${index + 1}: ${error}`);
        const name = file.file_name || 'photo.jpg';
        return { text: [caption, `Вложение ${index + 1}: ${name}`].filter(Boolean).join('\n'),
          file: { base64, name, mime: file.mime_type || (m.photo ? 'image/jpeg' : 'application/octet-stream'), index: index + 1 } };
      }
      return { text: caption };
    }));
    const files = prepared.flatMap(p => p.file ? [p.file] : []);
    const attachment = packAttachments(files);
    const task = prepared.map((p, i) => `[Сообщение ${i + 1}]\n${p.text}`).join('\n\n') +
      (files.length > 1 ? '\n\nВсе вложения находятся в приложенном TAR-архиве. Распакуй его и прочитай каждый файл; номер в имени соответствует сообщению.' : '');
    await handleText(chatId, session, task, env, {
      ...opts, intakeRoute: opts.intakeRoute || msg.intakeRoute, ...attachment, isVoice: prepared.some(p => p.isVoice),
    });
    return;
  }

  // Media branches take precedence over `text`. On the buffered/dispatch path
  // (IntakeBuffer._dispatch) a media message keeps its .photo/.voice/.document
  // field but gets .text overwritten with a coalesced tag string ("photo:<id>").
  // If we checked `text` first, that raw tag would be sent to the agent as the
  // task and the file would never be downloaded (voice never transcribed).
  // Instead: download/transcribe the media, and pass the human text — the
  // coalesced buffer with its own media tag-lines stripped — as the caption/task,
  // so BOTH the file and the surrounding words reach the agent.
  const humanCaption = msg.caption || stripMediaTags(text);
  const docIsMedia = doc && /^(audio|video)\//i.test(doc.mime_type || '');
  if (voice || audio) {
    const fileId = (voice || audio).file_id;
    const mimeType = (voice || audio).mime_type || null;
    await transcribeAndDispatch(chatId, session, env, opts, humanCaption, fileId, mimeType, '🎤');
  } else if (video || docIsMedia) {
    const src = video || doc;
    if (src.file_size && src.file_size > MAX_TG_DOWNLOAD_BYTES) {
      await sendMessage(env.BOT_TOKEN, chatId, tooBigMessage(src.file_size));
    } else {
      await transcribeAndDispatch(chatId, session, env, opts, humanCaption, src.file_id, src.mime_type || 'video/mp4', '🎬');
    }
  } else if (photo) {
    const largest = photo[photo.length - 1];
    if (largest.file_size && largest.file_size > MAX_TG_DOWNLOAD_BYTES) {
      await sendMessage(env.BOT_TOKEN, chatId, tooBigMessage(largest.file_size));
      return;
    }
    const placeholder = await sendMessage(env.BOT_TOKEN, chatId, '⏳ Загружаю фото…');
    const initialMsgId = placeholder?.result?.message_id ?? null;
    try {
      const { base64, error } = await downloadTgFileBase64(largest.file_id, env);
      if (error) {
        await sendMessage(env.BOT_TOKEN, chatId, `❌ Не удалось скачать фото: ${error}`);
      } else {
        const task = humanCaption || 'Фото';
        await handleText(chatId, session, task, env, {
          ...opts, initialMsgId,
          fileBase64: base64,
          fileName: 'photo.jpg',
          fileMimeType: 'image/jpeg',
          mode: opts.mode || null,
      controlEpoch: opts.controlEpoch,
      controlEpochs: opts.controlEpochs,
        });
      }
    } catch (e) {
      await sendMessage(env.BOT_TOKEN, chatId, `❌ Ошибка при загрузке фото: ${e.message}`);
    }
  } else if (doc) {
    if (doc.file_size && doc.file_size > MAX_TG_DOWNLOAD_BYTES) {
      await sendMessage(env.BOT_TOKEN, chatId, tooBigMessage(doc.file_size));
      return;
    }
    const placeholder = await sendMessage(env.BOT_TOKEN, chatId, '⏳ Загружаю документ…');
    const initialMsgId = placeholder?.result?.message_id ?? null;
    try {
      const { base64, error } = await downloadTgFileBase64(doc.file_id, env);
      if (error) {
        await sendMessage(env.BOT_TOKEN, chatId, `❌ Не удалось скачать файл: ${error}`);
      } else {
        const task = humanCaption || `Документ: ${doc.file_name || 'файл'}`;
        await handleText(chatId, session, task, env, {
          ...opts, initialMsgId,
          fileBase64: base64,
          fileName: doc.file_name || 'document',
          fileMimeType: doc.mime_type || 'application/octet-stream',
          mode: opts.mode || null,
      controlEpoch: opts.controlEpoch,
      controlEpochs: opts.controlEpochs,
        });
      }
    } catch (e) {
      await sendMessage(env.BOT_TOKEN, chatId, `❌ Ошибка при загрузке: ${e.message}`);
    }
  } else if (text) {
    await handleText(chatId, session, text, env, opts);
  } else {
    await sendMessage(env.BOT_TOKEN, chatId,
      '⚠️ Не могу обработать этот тип сообщения. Отправь текст, голосовое или аудиофайл.'
    );
  }
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

    // Run the task — agent creates/continues session
    const sessionId = route.sessionId;
    const context = opts.isVoice ? '[voice-message]' : null;

    // Use caller-supplied placeholder if provided (e.g. from doc handler), otherwise send our own.
    const placeholderRes = opts.initialMsgId
      ? null
      : await sendMessage(env.BOT_TOKEN, chatId, '📨 Передаю задачу агенту…');
    const initialMsgId = opts.initialMsgId ?? (placeholderRes?.result?.message_id ?? null);

    // Pass existing pinnedMsgId to agent — agent manages its content (skills, context, etc.)
    // If agent creates a new pinned message it returns the new ID; we store it for next time
    const checkGeneration = async () => {
      if (opts.intakeGeneration === undefined || !env.INTAKE) return true;
      const stub = env.INTAKE.get(env.INTAKE.idFromName(String(chatId)));
      const value = await stub.fetch('https://intake/check-generation', { method: 'POST', body: JSON.stringify({ generation: opts.intakeGeneration }) }).then(r => r.json());
      return value.current;
    };
    if (!await checkGeneration()) throw new Error('Передача отменена остановкой сессии');
    const result = await runTask(env, {
      userId: chatId,
      username: session.username,
      task: text,
      context,
      sessionId,
      forceNew: !!route.forceNew,
      contextFromSession: opts.intakeRoute ? (opts.intakeRoute.contextFromSession || null) : (session.contextFromSession || null),
      mode: opts.mode || null,
      controlEpoch: opts.controlEpoch,
      controlEpochs: opts.controlEpochs,
      initialMsgId,
      pinnedMsgId: session.pinnedMsgId || null,
      telegramUserId: session.telegramUserId,
      projectId: route.projectChosen ? route.projectId : (opts.intakeRoute ? opts.intakeRoute.projectId : (session.projectId || null)),
      newProjectName: route.forceNew && (route.newProject || (session.projectSelectionSessionId === route.sessionId && session.pendingNewProject))
        ? text.replace(/^\[Сообщение \d+\]\s*/u, '').split('\n')[0].trim().slice(0, 60) || 'Новый проект' : null,
      fileBase64: opts.fileBase64 || null,
      fileName: opts.fileName || null,
      fileMimeType: opts.fileMimeType || null,
    });

    if (!await checkGeneration()) return; // /fresh must keep its new session binding.
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
  } catch (err) {
    // The durable accumulator owns retry/retention. Never ACK a failed batch
    // or move it into the independent timed retry queue after /stop.
    if (opts.intakeOwned) throw err;
    // R10: a 15s timeout ≠ agent down. Probe /health to tell "busy" from "down"
    // so we never falsely tell the user to resend (which spawns a duplicate session).
    const kind = await classifyAgentError(env, err);

    // Class B self-heal (issue #604): the FIRST time we see 'down', queue one
    // delayed retry instead of dead-ending on the user. opts.isRetry marks the
    // scheduled retry itself — it must never queue a second one (cap-at-1).
    // Skip queueing when a file payload is attached: base64-inflated, it can
    // approach KV's 25MB value limit, and resending a file is trivial for the
    // user anyway — not worth the failure mode of scheduleRetry itself throwing.
    if (kind === 'down' && !opts.isRetry && !opts.fileBase64) {
      await scheduleRetry(env.SESSIONS, { chatId, text, opts });
      await sendMessage(env.BOT_TOKEN, chatId,
        '⏸ Агент временно недоступен. Попробую снова через 3 минуты — не отправляй повторно.'
      );
      return;
    }

    const userMsg = kind === 'busy'
      ? '↪️ Сервер отвечает, но подтверждение приёма задачи не пришло. Пока не отправляй повторно: запрос мог быть принят.'
      : kind === 'down' && opts.isRetry
      ? '⏸ Агент всё ещё недоступен после повторной попытки. Попробуй позже вручную.'
      : kind === 'down'
      ? '⏸ Агент временно недоступен. Попробуй прислать файл ещё раз через пару минут.'
      : `❌ Ошибка: ${err.message}`;
    await sendMessage(env.BOT_TOKEN, chatId, userMsg);
  }
}

// Class B self-heal (issue #604): drained by the Cron Trigger in index.js's
// scheduled() every ~1min. Re-fetches the session fresh (not a stale snapshot)
// so a retry doesn't fight a session the user has since moved on from; skips
// silently if the user logged out in the meantime.
export async function processDueRetries(env) {
  const due = await takeDueRetries(env.SESSIONS);
  for (const { chatId, text, opts } of due) {
    const session = await getSession(env.SESSIONS, chatId);
    if (!session) continue;
    await handleText(chatId, session, text, env, { ...opts, isRetry: true });
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

  // Ambiguous — show picker with all recent sessions
  return { type: 'disambiguate', sessions: recentSessions.slice(0, 4) };
}

// New-dialog project picker (issue #517). Uses the project INDEX in callback_data
// (pp:<i>) — typed project ids can be long Cyrillic slugs that blow the 64-byte
// callback_data limit. The pp: handler re-fetches the list and looks up by index
// (same ordering as GET /project-decision → listProjects, most-recent first).
export async function sendProjectPicker(botToken, chatId, choices, activeId, env) {
  // Descriptive body + numbered tap-buttons — same shape as the session picker
  // (renderSessionList). A project carries a durable 3-sense summary (start/middle/end)
  // from the agent; render it so the user can tell projects apart, instead of a bare
  // name button. Falls back to name-only when the summary hasn't matured yet.
  const list = choices.slice(0, 8);
  const lines = ['📂 <b>В какой проект добавить новый диалог?</b>', '', 'Выбери номер проекта ниже:', ''];
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
  const fileRes = await fetch(
    `${tgBase}/bot${env.BOT_TOKEN}/getFile?file_id=${fileId}`
  );
  const fileData = await fileRes.json();
  if (!fileData.ok) {
    return { transcript: null, error: `getFile failed: ${JSON.stringify(fileData)}` };
  }

  // File download always goes through api.telegram.org/file/ — use same proxy base
  const audioUrl = `${tgBase}/file/bot${env.BOT_TOKEN}/${fileData.result.file_path}`;
  const audioRes = await fetch(audioUrl);
  if (!audioRes.ok) {
    return { transcript: null, error: `audio download ${audioRes.status}` };
  }
  const audioBuffer = await audioRes.arrayBuffer();

  const dgRes = await fetch(
    'https://api.deepgram.com/v1/listen?model=nova-2&language=ru&smart_format=true',
    {
      method: 'POST',
      headers: {
        'Authorization': `Token ${env.DEEPGRAM_API_KEY}`,
        'Content-Type': mimeType || 'audio/ogg; codecs=opus',
      },
      body: audioBuffer,
    }
  );
  const dgText = await dgRes.text();
  if (!dgRes.ok) {
    return { transcript: null, error: `deepgram ${dgRes.status}: ${dgText.slice(0, 200)}` };
  }
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
