// Voice/audio transcription — shared by the intake accumulator (buffered path)
// and the direct handler (reply / addressed-to-bot path).
//
// The intake buffer transcribes ONCE, at append time, and stores the text on the
// message (msg.transcript) instead of the audio ref. That is what lets a
// multi-voice buffer keep EVERY voice: coalesceItem reads msg.transcript, so the
// launch task carries all transcripts in order, and dispatch never re-transcribes
// the last file (the double-transcription the owner flagged, #74).

import { sendMessage, sendDocument } from './telegram.js';

export function transcriptPreview(text, maxSentences = 3) {
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

// Show the transcript back to the user: inline (🎤 …) when short, or as a .txt
// document when long so the chat stays readable.
export async function announceTranscript(env, chatId, transcript) {
  if (!chatId) return;
  if (transcript.length < 800) {
    await sendMessage(env.BOT_TOKEN, chatId, `🎤 ${transcript}`);
    return;
  }
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const filename = `transcript-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}.txt`;
  const preview = transcriptPreview(transcript, 3);
  await sendDocument(env.BOT_TOKEN, chatId, filename, transcript, `🎤 ${preview}…`);
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

// Transcribe a voice/audio message ONCE and fold the text into msg.transcript,
// dropping the audio ref so the coalescer/dispatch treat it as text. Returns the
// (possibly enriched) message. On failure keeps the audio ref so a later path can
// retry, and surfaces the error instead of silently dropping the voice.
export async function enrichVoiceMessage(msg, env) {
  const media = msg?.voice || msg?.audio;
  if (!media || msg.transcript) return msg;
  const chatId = msg.chat?.id;
  const { transcript, error } = await transcribeVoice(media.file_id, media.mime_type || null, env);
  if (!transcript) {
    if (chatId) await sendMessage(env.BOT_TOKEN, chatId, `❌ Транскрипция не удалась: ${error}`);
    return msg;
  }
  await announceTranscript(env, chatId, transcript);
  const { voice, audio, caption, ...rest } = msg;
  // Preserve a caption typed alongside the voice note.
  const text = caption ? `${caption}\n${transcript}` : transcript;
  return { ...rest, transcript: text };
}
