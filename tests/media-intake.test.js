import { describe, expect, it, vi } from 'vitest';
import { prepareTelegramArtifact, transcribeIngressAudio } from '../src/sandbox-tg/media-intake.js';

const profile = { profileId: 'profile-1', ingressRef: 'tg:probability_cat_bot:1001:7' };
const attachment = { type: 'voice', fileId: 'telegram-file-secret', fileName: 'voice.ogg', mimeType: 'audio/ogg', fileSize: 5 };
const bytes = new TextEncoder().encode('audio');

describe('Telegram media intake', () => {
  it('transcribes the exact uploaded voice bytes and fails closed on missing or empty speech service', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ results: { channels: [{ alternatives: [{ transcript: '  Synthetic voice received.  ' }] }] } }));
    expect(await transcribeIngressAudio('test-deepgram-key', bytes, 'audio/ogg', fetchImpl)).toBe('Synthetic voice received.');
    const [url, request] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.deepgram.com/v1/listen?model=nova-3&language=multi&smart_format=true');
    expect(request).toMatchObject({ method: 'POST', headers: { Authorization: 'Token test-deepgram-key', 'Content-Type': 'audio/ogg' }, body: bytes });
    await expect(transcribeIngressAudio(null, bytes)).rejects.toMatchObject({ retryable: true });
    await expect(transcribeIngressAudio('test-deepgram-key', bytes, 'audio/ogg', async () => Response.json({ results: { channels: [{ alternatives: [{ transcript: '' }] }] } }))).rejects.toThrow('no usable text');
    await expect(transcribeIngressAudio('test-deepgram-key', bytes, 'audio/ogg', async () => new Response('', { status: 429 }))).rejects.toMatchObject({ retryable: true });
    await expect(transcribeIngressAudio('test-deepgram-key', bytes, 'audio/ogg', async () => new Response('', { status: 401 }))).rejects.toMatchObject({ retryable: false });
  });
  it('streams only bytes and opaque identity to the buffer; never forwards Telegram file IDs', async () => {
    let request;
    const fetchImpl = vi.fn(async url => url.includes('/getFile')
      ? Response.json({ ok: true, result: { file_path: 'voice/path', file_size: bytes.byteLength } })
      : new Response(bytes));
    const buffer = { fetch: vi.fn(async (url, init) => {
      request = { url, init };
      const ref = init.headers['x-artifact-ref'];
      const { sha256Hex } = await import('../src/ingress-buffer/worker.js');
      const sha256 = await sha256Hex(bytes);
      return Response.json({ manifest: { contractVersion: 1, ref, version: sha256, ownerProfileId: profile.profileId, mediaType: 'audio/ogg', name: 'voice.ogg', sizeBytes: bytes.byteLength, sha256 } }, { status: 201 });
    }) };

    const manifest = await prepareTelegramArtifact({ message: {}, attachment, profile,
      config: { telegramApiBase: 'https://telegram.test', botToken: 'secret-bot-token' },
      buffer, bufferToken: 'buffer-secret', fetchImpl });

    expect(manifest.ownerProfileId).toBe(profile.profileId);
    expect(request.url).toBe('https://ingress-buffer/v1/artifacts');
    expect(request.init.headers.authorization).toBe('Bearer buffer-secret');
    expect(request.init.headers['x-artifact-ref']).not.toContain(attachment.fileId);
    expect(new TextDecoder().decode(request.init.body)).toBe('audio');
    expect(JSON.stringify(request)).not.toContain(attachment.fileId);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the buffer returns a mismatched manifest', async () => {
    const fetchImpl = vi.fn(async url => url.includes('/getFile')
      ? Response.json({ ok: true, result: { file_path: 'voice/path', file_size: bytes.byteLength } })
      : new Response(bytes));
    const buffer = { fetch: vi.fn(async () => Response.json({ manifest: { contractVersion: 1, ref: 'wrong' } })) };
    await expect(prepareTelegramArtifact({ message: {}, attachment, profile,
      config: { telegramApiBase: 'https://telegram.test', botToken: 'secret-bot-token' },
      buffer, bufferToken: 'buffer-secret', fetchImpl })).rejects.toThrow('invalid manifest');
  });
});
