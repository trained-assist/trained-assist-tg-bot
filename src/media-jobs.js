// Per-attachment durable state machine. No byte transfer in intake/webhook requests.
import { checkMediaResponse } from './lib/media-retry.js';
export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
export const digest = async bytes => hex(await crypto.subtle.digest('SHA-256', bytes));
export const mediaEnabled = env => env.MEDIA_PIPELINE === 'r2' && env.MEDIA_JOBS && env.MEDIA_BUCKET;
export function mediaOf(msg) {
  return msg.voice || msg.audio || msg.video || msg.photo?.at(-1) || msg.document;
}
export function needsTranscript(msg) {
  return !!(msg.voice || msg.audio || msg.video || /^(audio|video)\//i.test(msg.document?.mime_type || ''));
}
export function ackText(msg) {
  if (needsTranscript(msg)) return '🎙 Принял голосовое, расшифровываю…';
  if (msg.photo) return '📷 Принял фото';
  return '📎 Принял вложение';
}
export async function mediaId(msg) {
  const file = mediaOf(msg);
  return digest(new TextEncoder().encode(`${msg.chat.id}:${msg.message_id}:${file.file_unique_id || file.file_id}`));
}
export function objectKey(username, id) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(username) || !/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid media owner/id');
  return `intake/${username}/${id}`;
}
export async function enqueueMedia(msg, env, session, retry = false) {
  const id = await mediaId(msg);
  const response = await env.MEDIA_JOBS.get(env.MEDIA_JOBS.idFromName(`${session.username}:${id}`)).fetch(
    'https://media/enqueue', { method: 'POST', body: JSON.stringify({ msg, username: session.username, retry }) });
  if (!response.ok) throw new Error('Media queue unavailable');
  return { ...msg, mediaJob: id };
}
async function boundedBytes(response) {
  checkMediaResponse(response, 'Media');
  if (Number(response.headers.get('content-length')) > MAX_MEDIA_BYTES) {
    await response.body.cancel(); throw Object.assign(new Error('Файл больше 20 MB'), { permanent: true });
  }
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_MEDIA_BYTES) { await reader.cancel(); throw Object.assign(new Error('Файл больше 20 MB'), { permanent: true }); }
    chunks.push(value);
  }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
async function saveObject(env, username, id, bytes, name, mime) {
  const sha256 = await digest(bytes);
  const object = await env.MEDIA_BUCKET.put(objectKey(username, id), bytes, {
    sha256, httpMetadata: { contentType: mime }, customMetadata: { name, sha256 },
  });
  if (!object || object.size !== bytes.byteLength) throw new Error('R2 did not confirm media size');
  return { storage: 'r2', version: 1, id, name, mime, size: object.size, sha256 };
}
function reference(object, id) {
  return { storage: 'r2', version: 1, id, name: object.customMetadata.name,
    mime: object.httpMetadata.contentType, size: object.size, sha256: object.customMetadata.sha256 };
}
export async function serveMedia(request, env) {
  // Shared internal credential only. Never accept a URL/key supplied by the client.
  if (!env.AGENT_SECRET || request.headers.get('authorization') !== `Bearer ${env.AGENT_SECRET}`) return new Response('Unauthorized', { status: 401 });
  if (!env.MEDIA_BUCKET) return new Response('Media unavailable', { status: 503 });
  const url = new URL(request.url); let key;
  try { key = objectKey(url.searchParams.get('username'), url.searchParams.get('id')); }
  catch { return new Response('Invalid reference', { status: 400 }); }
  const object = await env.MEDIA_BUCKET.get(key);
  if (!object) return new Response('Not found', { status: 404 });
  return new Response(object.body, { headers: {
    'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
    'Content-Length': String(object.size), 'Cache-Control': 'private, no-store',
    'X-Media-SHA256': object.customMetadata?.sha256 || '',
  } });
}
export class MediaJob {
  constructor(state, env) { this.state = state; this.env = env; }
  async fetch(request) {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/enqueue') return new Response('Not found', { status: 404 });
    const input = await request.json();
    const id = await mediaId(input.msg);
    objectKey(input.username, id);
    // Atomic enqueue/alarm; duplicate updates cannot replace an owner's job.
    await this.state.storage.transaction(async tx => {
      const job = await tx.get('job');
      if (job && (job.username !== input.username || job.id !== id)) throw new Error('Job identity mismatch');
      if (!job) {
        await tx.put('job', { id, username: input.username, msg: input.msg, stage: 'download', attempts: 0 });
        await tx.setAlarm(Date.now() + 1);
      } else if (input.retry && job.stage === 'failed') {
        job.stage = job.resumeStage; job.attempts = 0; delete job.error;
        await tx.put('job', job); await tx.setAlarm(Date.now() + 1);
      } else if (job.stage === 'done' && input.retry) {
        // Redeliver a completed result if intake previously failed to persist it.
        job.stage = 'deliver'; await tx.put('job', job); await tx.setAlarm(Date.now() + 1);
      } else if (!['done', 'failed'].includes(job.stage) && await tx.getAlarm() === null) {
        // Reconciliation can revive a job after platform alarm retries exhausted.
        await tx.setAlarm(Date.now() + 1);
      }
    });
    return Response.json({ accepted: true, id });
  }
  async alarm() {
    const job = await this.state.storage.get('job');
    if (!job || ['done', 'failed'].includes(job.stage)) return;
    // Watchdog survives isolate termination/network awaits. One job per DO.
    await this.state.storage.setAlarm(Date.now() + 180000);
    let retryDelay = 0;
    try {
      if (job.stage === 'download') {
        const key = objectKey(job.username, job.id);
        const existing = await this.env.MEDIA_BUCKET.head(key);
        if (existing) job.fileRef = reference(existing, job.id);
        else {
          const file = mediaOf(job.msg);
          if (file.file_size > MAX_MEDIA_BYTES) throw Object.assign(new Error('Файл больше 20 MB'), { permanent: true });
          const tg = (this.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
          const metaResponse = await fetch(`${tg}/bot${this.env.BOT_TOKEN}/getFile?file_id=${encodeURIComponent(file.file_id)}`, { signal: AbortSignal.timeout(20000) });
          checkMediaResponse(metaResponse, 'Telegram');
          const meta = await metaResponse.json();
          if (!meta.ok || !meta.result?.file_path) throw Object.assign(new Error('Telegram не отдал файл'), { permanent: true });
          const bytes = await boundedBytes(await fetch(`${tg}/file/bot${this.env.BOT_TOKEN}/${meta.result.file_path}`, { signal: AbortSignal.timeout(120000) }));
          const expected = meta.result.file_size ?? file.file_size;
          if (expected != null && expected !== bytes.byteLength) throw new Error('Incomplete Telegram file');
          const name = (file.file_name || (job.msg.photo ? 'photo.jpg' : job.msg.video ? 'video.mp4' : job.msg.voice || job.msg.audio ? 'audio.ogg' : 'file')).replace(/[^a-zA-Z0-9._() -]/g, '_').slice(0, 200);
          job.fileRef = await saveObject(this.env, job.username, job.id, bytes, name, file.mime_type || (job.msg.photo ? 'image/jpeg' : job.msg.voice ? 'audio/ogg' : job.msg.video ? 'video/mp4' : 'application/octet-stream'));
        }
        job.stage = needsTranscript(job.msg) ? 'transcribe' : 'deliver';
      } else if (job.stage === 'transcribe') {
        const transcriptId = await digest(new TextEncoder().encode(`${job.id}:transcript`));
        const saved = await this.env.MEDIA_BUCKET.get(objectKey(job.username, transcriptId));
        if (saved) {
          job.transcript = await saved.text(); job.transcriptRef = reference(saved, transcriptId);
        } else {
          if (!this.env.DEEPGRAM_API_KEY) throw Object.assign(new Error('Распознавание не настроено'), { permanent: true });
          const original = await this.env.MEDIA_BUCKET.get(objectKey(job.username, job.id));
          if (!original) throw new Error('Original missing from R2');
          const response = await fetch('https://api.deepgram.com/v1/listen?model=nova-2&language=ru&smart_format=true', {
            method: 'POST', headers: { Authorization: `Token ${this.env.DEEPGRAM_API_KEY}`, 'Content-Type': job.fileRef.mime },
            body: original.body, signal: AbortSignal.timeout(120000), duplex: 'half',
          });
          checkMediaResponse(response, 'Распознавание');
          const data = await response.json();
          job.transcript = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
          if (!job.transcript) throw Object.assign(new Error('Не удалось распознать речь'), { permanent: true });
          job.transcriptRef = await saveObject(this.env, job.username, transcriptId, new TextEncoder().encode(job.transcript), `transcript-${job.msg.message_id}.txt`, 'text/plain; charset=utf-8');
        }
        job.stage = 'deliver';
      } else if (job.stage === 'deliver' || job.stage === 'notify-failure') {
        const threadId = job.msg.message_thread_id;
        const key = Number.isInteger(threadId) && threadId > 0 ? `${job.msg.chat.id}:${threadId}` : String(job.msg.chat.id);
        const stub = this.env.INTAKE.get(this.env.INTAKE.idFromName(key));
        const response = await stub.fetch('https://intake/media-result', { method: 'POST', body: JSON.stringify({
          id: job.id, messageId: job.msg.message_id, username: job.username,
          ...(job.stage === 'notify-failure' ? { error: job.error } : { fileRef: job.fileRef, transcript: job.transcript, transcriptRef: job.transcriptRef }),
        }) });
        if (!response.ok) throw new Error('Intake did not accept media result');
        job.stage = job.stage === 'notify-failure' ? 'failed' : 'done';
      }
      job.attempts = 0;
    } catch (error) {
      job.attempts++;
      retryDelay = error.retryAfterMs || 0;
      const terminal = retryDelay > 300000 || error.permanent || (error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status));
      // Delivery retries indefinitely at a capped rate: never strand an intake reservation.
      if (!['deliver', 'notify-failure'].includes(job.stage) && (terminal || job.attempts >= 3)) {
        job.resumeStage = job.stage; job.stage = 'notify-failure';
        // No upstream URLs/tokens in user-visible error or durable state.
        job.error = error.permanent ? error.message : 'Временный сбой обработки файла'; job.attempts = 0;
      }
    }
    await this.state.storage.transaction(async tx => {
      await tx.put('job', job);
      if (['done', 'failed'].includes(job.stage)) await tx.deleteAlarm();
      else await tx.setAlarm(Date.now() + (job.attempts ? Math.min(300000, Math.max(retryDelay, 1000 * 2 ** Math.min(job.attempts, 8))) : 1));
    });
  }
}
