import { TELEGRAM_FILE_SIZE_LIMIT_BYTES } from './contract.js';
import { sha256Hex } from '../ingress-buffer/worker.js';

export class MediaIntakeError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.name = 'MediaIntakeError';
    this.retryable = retryable;
  }
}

async function boundedResponseBytes(response) {
  if (!response.ok || !response.body) throw new MediaIntakeError('telegram media is unavailable', { retryable: response.status >= 500 });
  const contentLength = response.headers.get('content-length');
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > TELEGRAM_FILE_SIZE_LIMIT_BYTES)) {
    await response.body.cancel();
    throw new MediaIntakeError('media exceeds the 20 MiB limit');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > TELEGRAM_FILE_SIZE_LIMIT_BYTES) {
      await reader.cancel();
      throw new MediaIntakeError('media exceeds the 20 MiB limit');
    }
    chunks.push(value);
  }
  if (contentLength && Number(contentLength) !== size) throw new MediaIntakeError('telegram media size mismatch', { retryable: true });
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function mediaExtensionForMime(mime, fallback = 'bin') {
  const value = String(mime || '').toLowerCase();
  if (value.includes('ogg')) return 'ogg';
  if (value.includes('mpeg') || value.includes('mp3')) return 'mp3';
  if (value.includes('wav')) return 'wav';
  if (value.includes('webm')) return 'webm';
  if (value.includes('flac')) return 'flac';
  if (value.includes('mp4') || value.includes('m4a') || value.includes('x-m4a') || value.includes('aac')) return 'm4a';
  if (value.includes('pdf')) return 'pdf';
  if (value.includes('json')) return 'json';
  if (value.includes('csv')) return 'csv';
  if (value.includes('msword') || value.includes('wordprocessingml')) return 'docx';
  if (value.includes('text/plain')) return 'txt';
  return fallback;
}

export function googleDocUrlOf(value) {
  const text = Array.isArray(value) ? value.join('\n') : String(value ?? '');
  const match = text.match(/https?:\/\/[^\s<>"')]+/i);
  if (!match) return null;
  try {
    const url = new URL(match[0]);
    const host = url.hostname.toLowerCase();
    if (!host.includes('docs.google.com') && !host.includes('drive.google.com')) return null;
    if (!/(document|spreadsheets|presentation|forms)\/d\//i.test(url.pathname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function nameForAttachment(attachment) {
  let fallback = 'attachment';
  if (attachment?.type === 'voice') {
    const mime = attachment.mimeType || attachment.mime || '';
    fallback = mime ? `audio.${mediaExtensionForMime(mime, 'ogg')}` : 'voice.ogg';
  } else if (attachment?.type === 'photo') {
    fallback = 'photo.jpg';
  } else if (attachment?.type === 'google_doc') {
    fallback = 'google-docs-link.txt';
  }
  return String(attachment?.fileName || fallback).replace(/[\/\\\u0000-\u001f\u007f]/g, '_').slice(0, 200) || fallback;
}

export async function prepareTelegramArtifact({ message, attachment, profile, config, buffer, bufferToken, fetchImpl = fetch }) {
  const { manifest } = await prepareTelegramArtifactWithBytes({ message, attachment, profile, config, buffer, bufferToken, fetchImpl });
  return manifest;
}

export async function prepareTelegramArtifactWithBytes({ message, attachment, profile, config, buffer, bufferToken, fetchImpl = fetch }) {
  if (!buffer || !String(bufferToken ?? '').trim()) throw new MediaIntakeError('media storage is not configured', { retryable: true });
  if (!attachment?.fileId || !profile?.profileId || !profile?.ingressRef) throw new MediaIntakeError('media metadata is incomplete');
  if (attachment.fileSize != null && attachment.fileSize > TELEGRAM_FILE_SIZE_LIMIT_BYTES) throw new MediaIntakeError('media exceeds the 20 MiB limit');

  const apiBase = String(config.telegramApiBase || 'https://api.telegram.org').replace(/\/+$/, '');
  let fileInfoResponse;
  try {
    fileInfoResponse = await fetchImpl(`${apiBase}/bot${config.botToken}/getFile?file_id=${encodeURIComponent(attachment.fileId)}`, {
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new MediaIntakeError('telegram media is temporarily unavailable', { retryable: true });
  }
  if (!fileInfoResponse.ok) throw new MediaIntakeError('telegram media is temporarily unavailable', { retryable: fileInfoResponse.status >= 500 });
  const fileInfo = await fileInfoResponse.json().catch(() => null);
  if (!fileInfo?.ok || typeof fileInfo.result?.file_path !== 'string') throw new MediaIntakeError('telegram did not provide the media file');
  const declaredSize = fileInfo.result.file_size ?? attachment.fileSize;
  if (declaredSize != null && declaredSize > TELEGRAM_FILE_SIZE_LIMIT_BYTES) throw new MediaIntakeError('media exceeds the 20 MiB limit');

  let fileResponse;
  try {
    fileResponse = await fetchImpl(`${apiBase}/file/bot${config.botToken}/${fileInfo.result.file_path}`, {
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new MediaIntakeError('telegram media is temporarily unavailable', { retryable: true });
  }
  const bytes = await boundedResponseBytes(fileResponse);
  if (declaredSize != null && declaredSize !== bytes.byteLength) throw new MediaIntakeError('telegram media size mismatch', { retryable: true });

  const ref = await sha256Hex(new TextEncoder().encode(`${profile.profileId}\u0000${profile.ingressRef}`));
  const name = nameForAttachment(attachment);
  const mediaType = String(attachment.mimeType || (attachment.type === 'voice' ? 'audio/ogg' : attachment.type === 'photo' ? 'image/jpeg' : 'application/octet-stream'))
    .split(';', 1)[0].trim().toLowerCase();
  let response;
  try {
    response = await buffer.fetch('https://ingress-buffer/v1/artifacts', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bufferToken}`,
        'content-type': mediaType,
        'content-length': String(bytes.byteLength),
        'x-artifact-owner-profile-id': profile.profileId,
        'x-artifact-ref': ref,
        'x-artifact-name': encodeURIComponent(name),
      },
      body: bytes,
    });
  } catch {
    throw new MediaIntakeError('media storage is temporarily unavailable', { retryable: true });
  }
  if (!response.ok) throw new MediaIntakeError('media storage refused the artifact', { retryable: response.status >= 500 });
  const result = await response.json().catch(() => null);
  const manifest = result?.manifest;
  if (!manifest || manifest.contractVersion !== 1 || manifest.ref !== ref
    || manifest.ownerProfileId !== profile.profileId || manifest.mediaType !== mediaType
    || manifest.name !== name || manifest.sizeBytes !== bytes.byteLength
    || typeof manifest.sha256 !== 'string' || manifest.version !== manifest.sha256) {
    throw new MediaIntakeError('media storage returned an invalid manifest');
  }
  if (await sha256Hex(bytes) !== manifest.sha256) throw new MediaIntakeError('media storage checksum mismatch');
  return { manifest, bytes };
}

export async function transcribeIngressAudio(apiKey, bytes, mimeType = 'audio/ogg', fetchImpl = fetch) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new MediaIntakeError('speech transcription is not configured', { retryable: true });
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > TELEGRAM_FILE_SIZE_LIMIT_BYTES) {
    throw new MediaIntakeError('speech audio is invalid');
  }
  const contentType = /^audio\/[a-z0-9.+-]+$/i.test(mimeType) ? mimeType : 'application/octet-stream';
  let response;
  try {
    response = await fetchImpl('https://api.deepgram.com/v1/listen?model=nova-3&language=multi&smart_format=true', {
      method: 'POST',
      headers: { Authorization: `Token ${apiKey}`, 'Content-Type': contentType },
      body: bytes,
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new MediaIntakeError('speech transcription is temporarily unavailable', { retryable: true });
  }
  if (!response.ok) throw new MediaIntakeError('speech transcription was refused', {
    retryable: response.status === 429 || response.status >= 500,
  });
  const result = await response.json().catch(() => null);
  const transcript = result?.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? '';
  if (!transcript || transcript.length > 100_000) throw new MediaIntakeError('speech transcription returned no usable text');
  return transcript;
}
