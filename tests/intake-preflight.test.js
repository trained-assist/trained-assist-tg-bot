import { describe, it, expect, vi, beforeEach } from 'vitest';
const mocks = vi.hoisted(() => ({ send: vi.fn(), doc: vi.fn(), stt: vi.fn(), download: vi.fn(), handle: vi.fn(), store: vi.fn(), transcriptStore: vi.fn(), release: vi.fn() }));
vi.mock('../src/lib/telegram.js', () => ({ sendMessage: mocks.send, sendDocument: mocks.doc,
  sendMessageWithKeyboard: mocks.send, editMessage: mocks.send, editMessageReplyMarkup: mocks.send,
  deleteMessage: mocks.send }));
vi.mock('../src/handlers/message.js', () => ({ transcribeVoice: mocks.stt, downloadTgFileBase64: mocks.download, handleMessage: mocks.handle }));
vi.mock('../src/lib/intake-files.js', () => ({ storeTelegramFile: mocks.store, storeTranscript: mocks.transcriptStore, releaseBufferPins: mocks.release }));
import { preflight, prepareIntake } from '../src/intake-preflight.js';
import { IntakeBuffer } from '../src/intake-buffer.js';
const msg = { chat: { id: 42 }, message_id: 1, text: 'ревью кандидатов' };
function world() {
  const map = new Map();
  const env = { AGENT_URL: 'https://agent.test', BOT_TOKEN: 't', AGENT_SECRET: 's', SESSIONS: {
    get: vi.fn(async () => JSON.stringify({ username: 'alice' })), put: vi.fn() } };
  const state = { storage: { get: async k => map.get(k), put: async (k,v) => map.set(k,v),
    delete: async k => map.delete(k), getAlarm: async () => null, setAlarm: vi.fn(), deleteAlarm: vi.fn() } };
  return { env, map, io: new IntakeBuffer(state, env) };
}
beforeEach(() => { vi.clearAllMocks(); mocks.send.mockResolvedValue({ ok: true, result: { message_id: 99 } });
  mocks.store.mockResolvedValue({ id: 'a'.repeat(64), name: 'photo.jpg', size: 5 });
  mocks.transcriptStore.mockResolvedValue({ id: 'b'.repeat(64), name: 'transcript.txt', size: 10 });
  mocks.stt.mockResolvedValue({ transcript: 'ревью кандидатов' });
  mocks.download.mockResolvedValue({ base64: 'aGVsbG8=' });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ answer: 'https://review.test', sessionId: 'qa-1' }))); });
const ingest = (io, message) => io.fetch(new Request('https://intake/ingest', { method: 'POST', body: JSON.stringify({ msg: message }) }));
describe('preflight before collector', () => {
  it('buffered input never triggers an intermediate quick answer; duplicates stay deduplicated', async () => {
    const { io, map } = world();
    await ingest(io, msg); await ingest(io, msg);
    expect(map.get('buf')).toHaveLength(1); expect(mocks.handle).not.toHaveBeenCalled();
    expect(fetch.mock.calls.filter(([url])=>url.endsWith('/intake-quick'))).toHaveLength(0);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('voice transcript is shown before quick request, never retranscribed at launch', async () => {
    const { env } = world();
    fetch.mockImplementation(async url => { expect(mocks.send.mock.calls[0][2]).toBe('🎤 ревью кандидатов'); return Response.json({ answer: null }); });
    const result = await preflight({ ...msg, text: undefined, voice: { file_id: 'v' } }, env);
    expect(result.msg.transcript).toBe('ревью кандидатов');
    await prepareIntake(result.msg, env, { username: 'alice' });
    expect(mocks.stt).toHaveBeenCalledTimes(1);
  });
  it('miss and HTTP failure keep original text for explicit launch', async () => {
    const { io, map } = world(); fetch.mockResolvedValue(new Response('', { status: 503 }));
    await ingest(io, msg);
    expect(map.get('buf')[0].text).toBe(msg.text);
    expect(mocks.handle).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(map.get('receiptDue')).toBeTruthy();
  });
  it('launch during five concurrent transcriptions cannot omit pending messages', async () => {
    const { io, map } = world(); let release;
    const wait = new Promise(r => { release = r; });
    mocks.stt.mockImplementation(async () => { await wait; return { transcript: 'сложная задача' }; });
    fetch.mockImplementation(async () => Response.json({ answer: null }));
    const pending = Array.from({ length: 5 }, (_, n) => ingest(io, { ...msg, text: undefined, message_id: n + 1, voice: { file_id: `v${n}` } }));
    await vi.waitFor(() => expect(mocks.stt).toHaveBeenCalledTimes(5));
    const response = await io.fetch(new Request('https://intake/flush', { method: 'POST' }));
    expect(await response.json()).toEqual({ preparing: true, queued: true }); expect(mocks.handle).not.toHaveBeenCalled();
    release(); await Promise.all(pending);
    expect(map.get('buf')).toHaveLength(5);
    await io.fetch(new Request('https://intake/flush', { method: 'POST' }));
    expect(mocks.handle).toHaveBeenCalledTimes(1);
    expect(mocks.handle.mock.calls[0][0].intakeItems.map(i => i.msg.transcript)).toEqual(Array(5).fill('сложная задача'));
  });
  it('photo caption cannot consume file as quick answer; stores a durable file ref, no KV bytes', async () => {
    const { env } = world(); const result = await preflight({ ...msg, photo: [{ file_id: 'p' }] }, env);
    expect(fetch.mock.calls).toEqual([]); expect(result.msg.fileRef.id).toBe('a'.repeat(64));
    expect(env.SESSIONS.put).not.toHaveBeenCalled();
  });
  it('uploads sandbox3 media to the passive buffer and removes Telegram file IDs before persistence', async () => {
    const { env } = world();
    Object.assign(env, {
      EXECUTION_BACKEND: 'control-plane', MEDIA_PIPELINE: 'ingress-buffer',
      TG_SANDBOX_BOT_USERNAME: 'ptichka_status_bot', TG_SANDBOX_BOT_TOKEN: 'fixture-bot-token',
      CONTROL_PLANE_URL: 'https://cp.example.test', CONTROL_PLANE_PRINCIPAL: 'sandbox-principal',
      CONTROL_PLANE_PROFILE: 'integration-sandbox3-v1', TELEGRAM_WEBHOOK_SECRET: 'fixture-webhook',
      TG_SLICE_ALLOWED_CHATS: '42', INGRESS_BUFFER_TOKEN: 'fixture-buffer-token',
    });
    const bytes = new TextEncoder().encode('hello');
    const digestBytes = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = [...new Uint8Array(digestBytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    fetch.mockImplementation(async url => String(url).includes('/getFile')
      ? Response.json({ ok: true, result: { file_path: 'test/brief.txt', file_size: bytes.byteLength } })
      : new Response(bytes, { headers: { 'content-length': String(bytes.byteLength) } }));
    let savedManifest;
    env.INGRESS_BUFFER = { fetch: async (_url, init) => {
      const headers = new Headers(init.headers);
      savedManifest = { contractVersion: 1, ref: headers.get('x-artifact-ref'),
        version: sha256, sha256, ownerProfileId: headers.get('x-artifact-owner-profile-id'),
        mediaType: headers.get('content-type'), name: decodeURIComponent(headers.get('x-artifact-name')),
        sizeBytes: bytes.byteLength };
      return Response.json({ manifest: savedManifest }, { status: 201 });
    } };
    const original = { ...msg, text: undefined, caption: 'review this', document: {
      file_id: 'telegram-private-file-id', file_unique_id: 'telegram-private-unique-id',
      file_name: 'brief.txt', mime_type: 'text/plain', file_size: bytes.byteLength,
    } };
    const prepared = await prepareIntake(original, env, { username: 'alice' });
    expect(prepared.artifactManifest).toEqual(savedManifest);
    expect(prepared.document).toEqual({ file_name: 'brief.txt', mime_type: 'text/plain', file_size: bytes.byteLength });
    expect(JSON.stringify(prepared)).not.toContain('telegram-private-file-id');
    expect(JSON.stringify(prepared)).not.toContain('telegram-private-unique-id');
  });
  it('failed transcription retains original voice for retry at launch', async () => {
    const { io, map } = world(); mocks.stt.mockResolvedValue({ error: 'unavailable' });
    await ingest(io, { ...msg, text: undefined, voice: { file_id: 'v' } });
    expect(map.get('buf')[0].msg.voice.file_id).toBe('v'); expect(map.get('buf')[0].preparingAt).toBeUndefined();
  });
});

// A later failure must not discard already paid-for transcription or file storage.
it('checkpoints transcript before transcript storage failure and retries without STT', async () => {
  const { env } = world();
  let saved;
  mocks.transcriptStore.mockRejectedValueOnce(new Error('storage unavailable'));
  const original = { ...msg, text: undefined, voice: { file_id: 'v' } };
  const checkpoint = async value => { saved = structuredClone(value); };
  await expect(prepareIntake(original, env, { username: 'alice' }, checkpoint)).rejects.toThrow('storage unavailable');
  expect(saved.transcript).toBe('ревью кандидатов');
  expect(saved.fileRef.id).toBe('a'.repeat(64));
  await prepareIntake(saved, env, { username: 'alice' }, checkpoint);
  expect(mocks.stt).toHaveBeenCalledTimes(1);
  expect(mocks.send.mock.calls.filter(c => c[2] === '🎤 ревью кандидатов')).toHaveLength(1);
});

it('ingest retains checkpointed STT after a transcript upload failure', async () => {
 const { io, map } = world();
 mocks.transcriptStore.mockRejectedValueOnce(new Error('upload unavailable'));
 await ingest(io, { ...msg, text: undefined, voice: { file_id: 'v' } });
 expect(map.get('buf')[0].msg.transcript).toBe('ревью кандидатов');
 expect(map.get('buf')[0].msg.transcriptNotified).toBe(false);
 expect(map.get('buf')[0].preparingAt).toBeUndefined();
});
