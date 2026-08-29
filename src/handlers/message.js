import { sendMessage } from '../lib/telegram.js';
import { getSession } from '../lib/kv.js';
import { runTask } from '../lib/agent-client.js';

export async function handleMessage(msg, env) {
  const { chat, text, voice, photo, document: doc } = msg;
  const chatId = chat.id;

  const session = await getSession(env.SESSIONS, chatId);
  if (!session) {
    return sendMessage(env.BOT_TOKEN, chatId,
      '👋 Сначала войди: /login username password'
    );
  }

  if (text) {
    await handleText(chatId, session, text, env);
  } else if (voice) {
    // TODO: download voice, transcribe via Deepgram, then handleText
    await sendMessage(env.BOT_TOKEN, chatId, '🎤 Голосовые — TODO: транскрипция Deepgram');
  } else if (photo) {
    // TODO: download highest-res photo, save to agent workDir
    await sendMessage(env.BOT_TOKEN, chatId, '🖼 Фото — TODO: передать агенту');
  } else if (doc) {
    // TODO: download document, save to agent workDir
    await sendMessage(env.BOT_TOKEN, chatId, '📎 Документ — TODO: передать агенту');
  }
}

async function handleText(chatId, session, text, env) {
  const thinkingMsg = await sendMessage(env.BOT_TOKEN, chatId, '⏳ Думаю…');

  try {
    await runTask(env, {
      userId: chatId,
      username: session.username,
      task: text,
      context: session.context || null,
    });
    // Agent streams result directly to Telegram; thinkingMsg will be edited by agent
  } catch (err) {
    await sendMessage(env.BOT_TOKEN, chatId, `❌ Ошибка: ${err.message}`);
  }
}
