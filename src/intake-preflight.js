// Normalize once at receipt; durable intake keeps text and lightweight file references.
import { getSession } from './lib/kv.js';
import { sendMessage, sendDocument } from './lib/telegram.js';
import { pickAgentUrl } from './lib/agent-client.js';
import { storeTelegramFile, storeTranscript, releaseBufferPins } from './lib/intake-files.js';
import { transcribeVoice } from './handlers/message.js';


export async function prepareIntake(msg, env, session, checkpoint = async () => {}) {
  if (msg.fileRef?.storage === 'r2') return msg;
  if (msg.mediaJob) throw new Error('Файл ещё обрабатывается');
  const MAX_BYTES = 20 * 1024 * 1024;
  const media = msg.voice || msg.audio || msg.video ||
    (msg.document && /^(audio|video)\//i.test(msg.document.mime_type || '') ? msg.document : null);
  if (media) {
    if (!msg.voice && media.file_size && media.file_size > MAX_BYTES) {
      await sendMessage(env.BOT_TOKEN, msg.chat.id,
        'Файл слишком большой для Telegram (>20 МБ) — я не смогу его получить напрямую. Загрузи, пожалуйста, в Google Drive, Яндекс Диск или любое облако и пришли мне ссылку — скачаю оттуда.',
        { reply_to_message_id: msg.message_id, allow_sending_without_reply: true }
      );
      return { ...msg, fileTooLarge: true };
    }
    const fileRef = await storeTelegramFile(msg, media, env, session);
    msg = { ...msg, fileRef };
    await checkpoint(msg);
    const { transcript, error } = msg.transcript ? { transcript: msg.transcript }
      : await transcribeVoice(media.file_id, media.mime_type || null, env);
    if (!transcript) throw new Error(error || 'Пустая расшифровка');
    const notifyTranscript = msg.transcriptNotified === false || !msg.transcript;
    msg = { ...msg, transcript, transcriptNotified: !notifyTranscript };
    await checkpoint(msg);
    const transcriptRef = await storeTranscript(msg, media, transcript, env, session);
    msg = { ...msg, transcriptRef };
    await checkpoint(msg);
    if (notifyTranscript) {
      const anchor = { reply_to_message_id: msg.message_id, allow_sending_without_reply: true };
      if (transcript.length < 800) await sendMessage(env.BOT_TOKEN, msg.chat.id, `🎤 ${transcript}`, anchor);
      else await sendDocument(env.BOT_TOKEN, msg.chat.id, `transcript-${msg.message_id}.txt`, transcript, '🎤 Расшифровка голосового');
    }
    // Keep the source media metadata for retry, but do not duplicate transcript in .text.
    msg = { ...msg, transcript, fileRef, transcriptRef, transcriptNotified: true };
    await checkpoint(msg);
    return msg;
  }
  const file = msg.photo?.[msg.photo.length - 1] || msg.document;
  if (file) {
    if (file.file_size && file.file_size > MAX_BYTES) {
      await sendMessage(env.BOT_TOKEN, msg.chat.id,
        'Файл слишком большой для Telegram (>20 МБ) — я не смогу его получить напрямую. Загрузи, пожалуйста, в Google Drive, Яндекс Диск или любое облако и пришли мне ссылку — скачаю оттуда.',
        { reply_to_message_id: msg.message_id, allow_sending_without_reply: true }
      );
      return { ...msg, fileTooLarge: true };
    }
    const fileRef = await storeTelegramFile(msg, file, env, session);
    const { attachmentKey, ...rest } = msg;
    return { ...rest, fileRef };
  }
  return msg;
}

export async function preflight(msg, env, checkpoint) {
  const session = await getSession(env.SESSIONS, msg.chat.id);
  if (!session) return { msg }; // normal login path remains authoritative
  const prepared = await prepareIntake(msg, env, session, checkpoint);
  const query = [prepared.text || prepared.caption, prepared.transcript].filter(Boolean).join('\n');
  // A photo/document must reach the agent with its caption; a text-only quick reply
  // cannot consume it. Transcribed audio is eligible just like typed text.
  if (!query || prepared.photo || (prepared.document && !prepared.transcript)) return { msg: prepared };
  try {
    const agentUrl = await pickAgentUrl(env, session.username, query);
    const response = await fetch(`${agentUrl}/intake-quick`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.AGENT_SECRET}` },
      body: JSON.stringify({ username: session.username, userId: msg.chat.id, query,
        messageId: msg.message_id, telegramUserId: session.telegramUserId, projectId: session.projectId }),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) return { msg: prepared };
    const result = await response.json();
    if (!result.answer || !result.sessionId) return { msg: prepared };
    const sent = await sendMessage(env.BOT_TOKEN, msg.chat.id, `⚡ ${result.answer}`, {
      reply_to_message_id: msg.message_id, allow_sending_without_reply: true,
      reply_markup: { inline_keyboard: [[{ text: '🔎 Разобраться подробнее', callback_data: `qa_more|${result.sessionId}` }]] },
    });
    if (!sent?.ok) throw new Error('Не удалось отправить быстрый ответ');
    await releaseBufferPins(env,session.username,[prepared.fileRef,prepared.transcriptRef].filter(Boolean));
    return { msg: prepared, handled: true };
  } catch (error) {
    console.warn('[intake preflight] quick unavailable:', error.message);
    return { msg: prepared }; // Never start a full agent as fallback.
  }
}
