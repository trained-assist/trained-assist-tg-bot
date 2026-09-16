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
  if (!response.ok) throw new Error(`Сохранение файла: HTTP ${response.status}`);
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
      const ref = await upload(env, session.username, id, name, mime, Buffer.from(cached.base64, 'base64'));
      return ref;
    }
  }
  const tg = (env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
  const response = await fetch(`${tg}/bot${env.BOT_TOKEN}/getFile?file_id=${encodeURIComponent(file.file_id)}`, { signal: AbortSignal.timeout(20000) });
  const result = await response.json();
  if (!result.ok) throw new Error('Telegram не отдал файл');
  if (result.result.file_size > MAX_BYTES) throw new Error('Файл больше 20 MB');
  const bytes = await fetch(`${tg}/file/bot${env.BOT_TOKEN}/${result.result.file_path}`, { signal: AbortSignal.timeout(120000) });
  if (!bytes.ok) throw new Error(`Загрузка файла: HTTP ${bytes.status}`);
  // Streaming transfer: no base64 expansion, no full-file worker allocation.
  return upload(env, session.username, id, name, mime, bytes.body);
}
export async function storeTranscript(msg, file, transcript, env, session) {
  const id = await identity(msg, file, 'transcript');
  if (msg.transcriptRef?.id === id) return msg.transcriptRef;
  return upload(env, session.username, id, `transcript-${msg.message_id}.txt`, 'text/plain; charset=utf-8', transcript);
}
export async function copyRefsToAgent(env, username, refs, agentUrl) {
  if (agentUrl === env.AGENT_URL) return;
  // The regional VM has its own disk; references must exist there before /run.
  for (const ref of refs) {
    const response = await fetch(endpoint(env.AGENT_URL, username, ref.id), {
      headers: auth(env), signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) throw new Error(`Чтение сохранённого файла: HTTP ${response.status}`);
    await upload(env, username, ref.id, ref.name, ref.mime, response.body, agentUrl);
  }
}
