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
    const { transcript, error } = await transcribeVoice(voice.file_id, env);
    if (transcript) {
      await sendMessage(env.BOT_TOKEN, chatId, `🎤 ${transcript}`);
      await handleText(chatId, session, transcript, env);
    } else {
      await sendMessage(env.BOT_TOKEN, chatId, `❌ Транскрипция не удалась: ${error}`);
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
  if (!fileData.ok) {
    return { transcript: null, error: `getFile failed: ${JSON.stringify(fileData)}` };
  }

  // Download OGG audio
  const audioUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${fileData.result.file_path}`;
  const audioRes = await fetch(audioUrl);
  if (!audioRes.ok) {
    return { transcript: null, error: `audio download ${audioRes.status}` };
  }
  const audioBuffer = await audioRes.arrayBuffer();

  // Transcribe via Deepgram — OGG/OPUS is Telegram's voice format
  const dgRes = await fetch(
    'https://api.deepgram.com/v1/listen?model=nova-2&language=ru&smart_format=true',
    {
      method: 'POST',
      headers: {
        'Authorization': `Token ${env.DEEPGRAM_API_KEY}`,
        'Content-Type': 'audio/ogg; codecs=opus',
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
    return { transcript: null, error: `empty transcript (size: ${audioBuffer.byteLength}b, confidence: ${confidence}, words: ${dgData?.results?.channels?.[0]?.alternatives?.[0]?.words?.length})` };
  }
  return { transcript, error: null };
}

async function handleText(chatId, session, text, env) {
  try {
    await runTask(env, {
      userId: chatId,
      username: session.username,
      task: text,
      context: session.context || null,
    });
    // Agent sends and edits its own "⏳ Думаю…" — Worker must not send a duplicate
  } catch (err) {
    await sendMessage(env.BOT_TOKEN, chatId, `❌ Ошибка: ${err.message}`);
  }
}
