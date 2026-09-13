import { sendMessage, sendMessageWithKeyboard, sendDocument } from '../lib/telegram.js';
import { getOrCreateMappedSession, setSession } from '../lib/kv.js';
import { runTask, getSessions, classifyMessage, getProjectDecision } from '../lib/agent-client.js';
import { renderSessionList } from './commands.js';

// Phrases that signal "start a new session" regardless of history
const NEW_SESSION_SIGNALS = [
  'другой вопрос', 'другая задача', 'новая задача', 'новый вопрос',
  'по другому', 'другая тема', 'смени тему', 'начни с нуля', 'начнём с нуля',
  'новая тема', 'забудь про', 'new task', 'new session', 'другое:',
];

const RECENT_SESSION_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours

export async function handleMessage(msg, env) {
  const { chat, text, voice, audio, photo, document: doc } = msg;
  const chatId = chat.id;

  const session = await getOrCreateMappedSession(env.SESSIONS, chatId, env, msg.from?.id);
  if (!session) {
    return sendMessage(env.BOT_TOKEN, chatId,
      '👋 Сначала войди: /login username password'
    );
  }

  if (text) {
    await handleText(chatId, session, text, env);
  } else if (voice || audio) {
    const fileId = (voice || audio).file_id;
    const mimeType = (voice || audio).mime_type || null;
    const { transcript, error } = await transcribeVoice(fileId, mimeType, env);
    if (transcript) {
      if (transcript.length < 800) {
        await sendMessage(env.BOT_TOKEN, chatId, `🎤 ${transcript}`);
      } else {
        const now = new Date();
        const pad = n => String(n).padStart(2, '0');
        const filename = `transcript-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}.txt`;
        const preview = transcriptPreview(transcript, 3);
        await sendDocument(env.BOT_TOKEN, chatId, filename, transcript, `🎤 ${preview}…`);
      }
      await handleText(chatId, session, transcript, env, { isVoice: true });
    } else {
      await sendMessage(env.BOT_TOKEN, chatId, `❌ Транскрипция не удалась: ${error}`);
    }
  } else if (photo) {
    const caption = msg.caption || '';
    const placeholder = await sendMessage(env.BOT_TOKEN, chatId, '⏳ Загружаю фото…');
    const initialMsgId = placeholder?.result?.message_id ?? null;
    try {
      const largest = photo[photo.length - 1];
      const { base64, error } = await downloadTgFileBase64(largest.file_id, env);
      if (error) {
        await sendMessage(env.BOT_TOKEN, chatId, `❌ Не удалось скачать фото: ${error}`);
      } else {
        const task = caption || 'Фото';
        await handleText(chatId, session, task, env, {
          initialMsgId,
          fileBase64: base64,
          fileName: 'photo.jpg',
          fileMimeType: 'image/jpeg',
        });
      }
    } catch (e) {
      await sendMessage(env.BOT_TOKEN, chatId, `❌ Ошибка при загрузке фото: ${e.message}`);
    }
  } else if (doc) {
    const caption = msg.caption || '';
    const placeholder = await sendMessage(env.BOT_TOKEN, chatId, '⏳ Загружаю документ…');
    const initialMsgId = placeholder?.result?.message_id ?? null;
    try {
      const { base64, error } = await downloadTgFileBase64(doc.file_id, env);
      if (error) {
        await sendMessage(env.BOT_TOKEN, chatId, `❌ Не удалось скачать файл: ${error}`);
      } else {
        const task = caption || `Документ: ${doc.file_name || 'файл'}`;
        await handleText(chatId, session, task, env, {
          initialMsgId,
          fileBase64: base64,
          fileName: doc.file_name || 'document',
          fileMimeType: doc.mime_type || 'application/octet-stream',
        });
      }
    } catch (e) {
      await sendMessage(env.BOT_TOKEN, chatId, `❌ Ошибка при загрузке: ${e.message}`);
    }
  } else {
    await sendMessage(env.BOT_TOKEN, chatId,
      '⚠️ Не могу обработать этот тип сообщения. Отправь текст, голосовое или аудиофайл.'
    );
  }
}

async function handleText(chatId, session, text, env, opts = {}) {
  try {
    const route = await resolveSessionRoute(chatId, session, text, env);

    if (route.type === 'disambiguate') {
      // Store the pending message, show session picker
      await setSession(env.SESSIONS, chatId, {
        ...session,
        pendingMessage: text,
        pendingMessageAt: Date.now(),
      });
      await sendDisambiguationKeyboard(env.BOT_TOKEN, chatId, route.sessions, session.activeSessionId);
      return;
    }

    // New-dialog project picker (issue #517): when this message starts a FRESH dialog
    // and the profile has ≥2 projects, ask which project before dispatching. Skip for
    // file uploads (the file can't be re-attached from the deferred pending message).
    const isNewDialog = route.forceNew || !session.lastSessionId;
    if (isNewDialog && !opts.fileBase64) {
      const decision = await getProjectDecision(env, { username: session.username, chatId });
      if (decision.action === 'ask' && decision.choices?.length) {
        await setSession(env.SESSIONS, chatId, {
          ...session,
          pendingMessage: text,
          pendingMessageAt: Date.now(),
        });
        await sendProjectPicker(env.BOT_TOKEN, chatId, decision.choices, decision.active);
        return;
      }
    }

    // Run the task — agent creates/continues session
    const sessionId = route.sessionId;
    const context = opts.isVoice ? '[voice-message]' : null;

    // Use caller-supplied placeholder if provided (e.g. from doc handler), otherwise send our own.
    const placeholderRes = opts.initialMsgId
      ? null
      : await sendMessage(env.BOT_TOKEN, chatId, '⏳ Запускаю…');
    const initialMsgId = opts.initialMsgId ?? (placeholderRes?.result?.message_id ?? null);

    // Pass existing pinnedMsgId to agent — agent manages its content (skills, context, etc.)
    // If agent creates a new pinned message it returns the new ID; we store it for next time
    const result = await runTask(env, {
      userId: chatId,
      username: session.username,
      task: text,
      context,
      sessionId,
      contextFromSession: session.contextFromSession || null,
      initialMsgId,
      pinnedMsgId: session.pinnedMsgId || null,
      telegramUserId: session.telegramUserId,
      projectId: session.projectId || null,
      fileBase64: opts.fileBase64 || null,
      fileName: opts.fileName || null,
      fileMimeType: opts.fileMimeType || null,
    });

    const newPinnedMsgId = result?.pinnedMsgId || session.pinnedMsgId || null;

    await setSession(env.SESSIONS, chatId, {
      ...session,
      lastSessionId: sessionId,
      lastMessageAt: Date.now(),
      pendingMessage: null,
      pendingMessageAt: null,
      activeSessionId: null,
      contextFromSession: null,
      pinnedMsgId: newPinnedMsgId,
    });
  } catch (err) {
    const isAgentDown = /HTTP 50[23]/.test(err.message) || err.name === 'TimeoutError';
    const userMsg = isAgentDown
      ? '⏸ Агент временно недоступен. Попробуй через минуту.'
      : `❌ Ошибка: ${err.message}`;
    await sendMessage(env.BOT_TOKEN, chatId, userMsg);
  }
}

/**
 * Decide what to do with the incoming message:
 *   { type: 'run', sessionId }           — run task with this session
 *   { type: 'disambiguate', sessions }   — show session picker first
 */
async function resolveSessionRoute(chatId, session, text, env) {
  const lc = text.toLowerCase();

  // 1. Explicit new-session signal in text → new session
  if (NEW_SESSION_SIGNALS.some(s => lc.includes(s))) {
    const newId = `s-${Math.abs(chatId)}-${Date.now()}`;
    return { type: 'run', sessionId: newId, forceNew: true };
  }

  // 2. User explicitly chose a session via /sessions button → use it once, then clear
  if (session.activeSessionId) {
    return { type: 'run', sessionId: session.activeSessionId };
  }

  // 3. No history at all → new session
  if (!session.lastSessionId) {
    const newId = `s-${Math.abs(chatId)}-${Date.now()}`;
    return { type: 'run', sessionId: newId };
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
export async function sendProjectPicker(botToken, chatId, choices, activeId) {
  const buttons = choices.slice(0, 8).map((c, i) => [{
    text: `${c.id === activeId ? '✅ ' : '📁 '}${c.label || c.name}`,
    callback_data: `pp:${i}`,
  }]);
  buttons.push([{ text: '➕ Новый проект', callback_data: 'pp:new' }]);
  const text = '📂 <b>В какой проект добавить новый диалог?</b>\n\nВыбери проект или создай новый:';
  return sendMessageWithKeyboard(botToken, chatId, text, buttons);
}

async function sendDisambiguationKeyboard(botToken, chatId, sessions, activeId) {
  // Descriptive text body (project · title · gist · meta) + numbered tap-buttons,
  // same renderer as /sessions and the new-dialog context picker. Replaces the old
  // 28-char truncated button labels that made dialogs indistinguishable.
  const { text, buttons } = renderSessionList(sessions, {
    callbackPrefix: 'sp',
    header: '↩ <b>В какой диалог добавить сообщение?</b>',
    hint: 'Выбери номер диалога ниже:',
  });
  buttons.push([{ text: '✨ Новый диалог', callback_data: 'sp:new' }]);

  return sendMessageWithKeyboard(botToken, chatId, text, buttons);
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

async function transcribeVoice(fileId, mimeType, env) {
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

async function downloadTgFileBase64(fileId, env) {
  const tgBase = (env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
  const fileRes = await fetch(`${tgBase}/bot${env.BOT_TOKEN}/getFile?file_id=${fileId}`);
  const fileData = await fileRes.json();
  if (!fileData.ok) return { base64: null, error: `getFile failed: ${JSON.stringify(fileData)}` };

  const fileUrl = `${tgBase}/file/bot${env.BOT_TOKEN}/${fileData.result.file_path}`;
  const fileRes2 = await fetch(fileUrl);
  if (!fileRes2.ok) return { base64: null, error: `download ${fileRes2.status}` };

  const buffer = await fileRes2.arrayBuffer();
  // btoa only works with Latin-1; for binary, encode via Uint8Array
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return { base64: btoa(binary), error: null };
}
