import { sendMessage, sendMessageWithKeyboard } from '../lib/telegram.js';
import { getOrCreateMappedSession, setSession } from '../lib/kv.js';
import { runTask, getSessions, classifyMessage } from '../lib/agent-client.js';

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
      await sendMessage(env.BOT_TOKEN, chatId, `🎤 ${transcript}`);
      await handleText(chatId, session, transcript, env, { isVoice: true });
    } else {
      await sendMessage(env.BOT_TOKEN, chatId, `❌ Транскрипция не удалась: ${error}`);
    }
  } else if (photo) {
    await sendMessage(env.BOT_TOKEN, chatId, '🖼 Фото — TODO: передать агенту');
  } else if (doc) {
    await sendMessage(env.BOT_TOKEN, chatId, '📎 Документ — TODO: передать агенту');
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

    // Run the task — agent creates/continues session
    const sessionId = route.sessionId;
    const context = opts.isVoice ? '[voice-message]' : null;

    const placeholderRes = await sendMessage(env.BOT_TOKEN, chatId, '⏳ Запускаю…');
    const initialMsgId = placeholderRes?.result?.message_id ?? null;

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
      projectDir: session.projectDir || null,
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
    const newId = `s-${chatId}-${Date.now()}`;
    return { type: 'run', sessionId: newId, forceNew: true };
  }

  // 2. User explicitly chose a session via /sessions button → use it once, then clear
  if (session.activeSessionId) {
    return { type: 'run', sessionId: session.activeSessionId };
  }

  // 3. No history at all → new session
  if (!session.lastSessionId) {
    const newId = `s-${chatId}-${Date.now()}`;
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

async function sendDisambiguationKeyboard(botToken, chatId, sessions, activeId) {
  function timeAgo(ts) {
    const m = Math.floor((Date.now() - ts) / 60000);
    if (m < 1) return 'только что';
    if (m < 60) return `${m}м`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}ч`;
    return `${Math.floor(h / 24)}д`;
  }

  const buttons = sessions.map(s => {
    const marker = s.id === activeId ? '🔵 ' : '';
    const label = `${marker}${s.topic.slice(0, 28)} · ${timeAgo(s.lastAt)}`;
    return [{ text: label, callback_data: `sp:${s.id}` }];
  });
  buttons.push([{ text: '✨ Новый диалог', callback_data: 'sp:new' }]);

  return sendMessageWithKeyboard(
    botToken, chatId,
    '↩ В какой диалог добавить сообщение?',
    buttons
  );
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
