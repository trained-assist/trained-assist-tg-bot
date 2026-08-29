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
    const transcript = await transcribeVoice(voice.file_id, env);
    if (transcript) {
      await handleText(chatId, session, transcript, env);
    } else {
      await sendMessage(env.BOT_TOKEN, chatId, '❌ Не удалось расшифровать голосовое сообщение');
    }
  } else if (photo) {
    // TODO: download highest-res photo, save to agent workDir
    await sendMessage(env.BOT_TOKEN, chatId, '🖼 Фото — TODO: передать агенту');
  } else if (doc) {
    // TODO: download document, save to agent workDir
    await sendMessage(env.BOT_TOKEN, chatId, '📎 Документ — TODO: передать агенту');
  }
}

async function transcribeVoice(fileId, env) {
  // Get file path from Telegram
  const fileRes = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/getFile?file_id=${fileId}`
  );
  const fileData = await fileRes.json();
  if (!fileData.ok) return null;

  // Download OGG audio
  const audioUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${fileData.result.file_path}`;
  const audioRes = await fetch(audioUrl);
  if (!audioRes.ok) return null;
  const audioBuffer = await audioRes.arrayBuffer();

  // Transcribe via Deepgram
  const dgRes = await fetch(
    'https://api.deepgram.com/v1/listen?model=nova-2&language=ru&smart_format=true',
    {
      method: 'POST',
      headers: {
        'Authorization': `Token ${env.DEEPGRAM_API_KEY}`,
        'Content-Type': 'audio/ogg',
      },
      body: audioBuffer,
    }
  );
  if (!dgRes.ok) return null;
  const dgData = await dgRes.json();
  return dgData?.results?.channels?.[0]?.alternatives?.[0]?.transcript || null;
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
