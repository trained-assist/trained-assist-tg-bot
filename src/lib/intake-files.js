import { retryMedia, readMedia, checkMediaResponse } from './media-retry.js';
import { Buffer } from 'node:buffer';
// Files go directly to durable disk. KV/DO retain only these small references.
const MAX_BYTES = 20 * 1024 * 1024;
const auth = env => ({ Authorization: `Bearer ${env.AGENT_SECRET}` });
const endpoint = (base, username, id, name) => `${base}/intake-files?${new URLSearchParams({ username, id, ...(name ? { name } : {}) })}`;
async function identity(msg, file, suffix = '') {
  const key = `${msg.chat.id}:${msg.message_id}:${file.file_unique_id || file.file_id}:${suffix}`;
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
async function upload(env, username, id, name, mime, body, base = env.AGENT_URL) {
  const response = await fetch(endpoint(base, username, id, name), { method: 'PUT',
    headers: { ...auth(env), 'Content-Type': mime || 'application/octet-stream' }, body,
    signal: AbortSignal.timeout(120000), duplex: 'half' });
  checkMediaResponse(response, 'Сохранение файла');
  const meta = await response.json();
  if (meta.id !== id || typeof meta.size !== 'number') throw new Error('Сервер не подтвердил сохранение файла');
  return meta;
}
export async function storeTelegramFile(msg, file, env, session) {
  if (file.file_size > MAX_BYTES) throw new Error('Файл больше 20 MB');
  const id = await identity(msg, file);
  if (msg.fileRef?.id === id) return msg.fileRef;
  const name = file.file_name || (msg.photo ? 'photo.jpg' : msg.video ? 'video.mp4' : 'audio.ogg');
  const mime = file.mime_type || (msg.photo ? 'image/jpeg' : 'application/octet-stream');
  // Migrate a legacy cached attachment if present; never create another cache entry.
  if (msg.attachmentKey) {
    const cached = await env.SESSIONS.get(msg.attachmentKey, { type: 'json' });
    if (cached?.base64) {
      const ref = await retryMedia(() => upload(env, session.username, id, name, mime, Buffer.from(cached.base64, 'base64')));
      return ref;
    }
  }
  const tg = (env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
  const result = await readMedia(`${tg}/bot${env.BOT_TOKEN}/getFile?file_id=${encodeURIComponent(file.file_id)}`);
  if (!result.ok) throw new Error('Telegram не отдал файл');
  if (result.result.file_size > MAX_BYTES) throw new Error('Файл больше 20 MB');
  return retryMedia(async () => {
    // Each attempt obtains a fresh stream; an already consumed upload is not reusable.
    const bytes = await fetch(`${tg}/file/bot${env.BOT_TOKEN}/${result.result.file_path}`, { signal: AbortSignal.timeout(120000) });
    checkMediaResponse(bytes, 'Загрузка файла');
    return upload(env, session.username, id, name, mime, bytes.body);
  });
}
export async function storeTranscript(msg, file, transcript, env, session) {
  const id = await identity(msg, file, 'transcript');
  if (msg.transcriptRef?.id === id) return msg.transcriptRef;
  return retryMedia(() => upload(env, session.username, id, `transcript-${msg.message_id}.txt`, 'text/plain; charset=utf-8', transcript));
}
export async function copyRefsToAgent(env, username, refs, agentUrl) {
  if (agentUrl === env.AGENT_URL) return;
  // The regional VM has its own disk; references must exist there before /run.
  for (const ref of refs) {
    await retryMedia(async () => {
      const response = await fetch(endpoint(env.AGENT_URL, username, ref.id), {
        headers: auth(env), signal: AbortSignal.timeout(120000),
      });
      checkMediaResponse(response, 'Чтение сохранённого файла');
      await upload(env, username, ref.id, ref.name, ref.mime, response.body, agentUrl);
    });
  }
}

// Release only the buffer pin after durable acceptance; this never deletes bytes.
// Failure retains the pin (disk cost) and cannot invalidate an accepted task.
export async function releaseBufferPins(env, username, refs, base = env.AGENT_URL) {
  const ids=[...new Set((refs||[]).map(ref=>ref.id).filter(id=>/^[a-f0-9]{64}$/.test(id)))];
  if(!ids.length)return;
  try {
    const response=await fetch(`${base}/intake-files/release`,{method:'POST',
      headers:{...auth(env),'Content-Type':'application/json'},body:JSON.stringify({username,ids}),signal:AbortSignal.timeout(5000)});
    if(!response.ok)console.warn('[intake pins] release deferred',response.status);
  }catch{console.warn('[intake pins] release deferred');}
}
