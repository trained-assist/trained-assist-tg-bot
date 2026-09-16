// Normalize once at receipt; durable intake keeps text and lightweight file references.
import { getSession } from './lib/kv.js';
import { sendMessage, sendDocument } from './lib/telegram.js';
import { pickAgentUrl } from './lib/agent-client.js';
import { transcribeVoice, downloadTgFileBase64 } from './handlers/message.js';

export const MEDIA_TTL_SECONDS = 48 * 60 * 60;

export async function prepareIntake(msg, env, session) {
  const media = msg.voice || msg.audio || msg.video ||
    (msg.document && /^(audio|video)\//i.test(msg.document.mime_type || '') ? msg.document : null);
  if (media) {
    if (media.file_size > 20 * 1024 * 1024) throw new Error('Файл больше 20 MB');
    const { transcript, error } = msg.transcript ? { transcript: msg.transcript }
      : await transcribeVoice(media.file_id, media.mime_type || null, env);
    if (!transcript) throw new Error(error || 'Пустая расшифровка');
    if (!msg.transcript) {
      const anchor = { reply_to_message_id: msg.message_id, allow_sending_without_reply: true };
      if (transcript.length < 800) await sendMessage(env.BOT_TOKEN, msg.chat.id, `🎤 ${transcript}`, anchor);
      else await sendDocument(env.BOT_TOKEN, msg.chat.id, `transcript-${msg.message_id}.txt`, transcript, '🎤 Расшифровка голосового');
    }
    // Keep the source media metadata for retry, but do not duplicate transcript in .text.
    return { ...msg, transcript };
  }
  const file = msg.photo?.[msg.photo.length - 1] || msg.document;
  if (file) {
    if (file.file_size > 18 * 1024 * 1024) return msg; // KV limit is 25 MiB including base64; download larger files at launch.
    const data = await downloadTgFileBase64(file.file_id, env);
    if (data.error) throw new Error(data.error);
    const attachmentKey = `intake-media:${session.username}:${msg.chat.id}:${msg.message_id}`;
    await env.SESSIONS.put(attachmentKey, JSON.stringify(data), { expirationTtl: MEDIA_TTL_SECONDS });
    return { ...msg, attachmentKey };
  }
  return msg;
}

export async function preflight(msg, env) {
  const session = await getSession(env.SESSIONS, msg.chat.id);
  if (!session) return { msg }; // normal login path remains authoritative
  const prepared = await prepareIntake(msg, env, session);
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
    return { msg: prepared, handled: true };
  } catch (error) {
    console.warn('[intake preflight] quick unavailable:', error.message);
    return { msg: prepared }; // Never start a full agent as fallback.
  }
}
