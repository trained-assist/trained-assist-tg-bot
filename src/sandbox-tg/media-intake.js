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

function nameForAttachment(attachment) {
  const fallback = attachment.type === 'voice' ? 'voice.ogg' : attachment.type === 'photo' ? 'photo.jpg' : 'attachment';
  return String(attachment.fileName || fallback).replace(/[\/\\\u0000-\u001f\u007f]/g, '_').slice(0, 200) || fallback;
}

export async function prepareTelegramArtifact({ message, attachment, profile, config, buffer, bufferToken, fetchImpl = fetch }) {
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
  return manifest;
}
