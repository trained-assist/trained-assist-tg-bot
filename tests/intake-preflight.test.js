import { describe, it, expect, vi, beforeEach } from 'vitest';
const mocks = vi.hoisted(() => ({ send: vi.fn(), doc: vi.fn(), stt: vi.fn(), download: vi.fn(), handle: vi.fn(), store: vi.fn(), transcriptStore: vi.fn() }));
vi.mock('../src/lib/telegram.js', () => ({ sendMessage: mocks.send, sendDocument: mocks.doc,
  sendMessageWithKeyboard: mocks.send, editMessage: mocks.send, editMessageReplyMarkup: mocks.send }));
vi.mock('../src/handlers/message.js', () => ({ transcribeVoice: mocks.stt, downloadTgFileBase64: mocks.download, handleMessage: mocks.handle }));
vi.mock('../src/lib/intake-files.js', () => ({ storeTelegramFile: mocks.store, storeTranscript: mocks.transcriptStore }));
import { preflight, prepareIntake } from '../src/intake-preflight.js';
import { IntakeBuffer } from '../src/intake-buffer.js';
const msg = { chat: { id: 42 }, message_id: 1, text: 'ревью кандидатов' };
function world() {
  const map = new Map();
  const env = { AGENT_URL: 'https://agent.test', BOT_TOKEN: 't', AGENT_SECRET: 's', SESSIONS: {
    get: vi.fn(async () => JSON.stringify({ username: 'alice' })), put: vi.fn() } };
  const state = { storage: { get: async k => map.get(k), put: async (k,v) => map.set(k,v),
    delete: async k => map.delete(k), setAlarm: vi.fn(), deleteAlarm: vi.fn() } };
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
  it('quick hit sends expandable answer, no agent launch and no collector; duplicate is ignored', async () => {
    const { io, map } = world();
    await ingest(io, msg); await ingest(io, msg);
    expect(map.get('buf')).toEqual([]); expect(mocks.handle).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0][3].reply_markup.inline_keyboard[0][0].callback_data).toBe('qa_more|qa-1');
  });
  it('voice transcript is shown before quick request, never retranscribed at launch', async () => {
    const { env } = world();
    fetch.mockImplementation(async () => { expect(mocks.send.mock.calls[0][2]).toBe('🎤 ревью кандидатов'); return Response.json({ answer: null }); });
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
    expect(mocks.send.mock.calls.at(-1)[2]).toContain('Накапливаю');
  });
  it('launch during five concurrent transcriptions cannot omit pending messages', async () => {
    const { io, map } = world(); let release;
    const wait = new Promise(r => { release = r; });
    mocks.stt.mockImplementation(async () => { await wait; return { transcript: 'сложная задача' }; });
    fetch.mockImplementation(async () => Response.json({ answer: null }));
    const pending = Array.from({ length: 5 }, (_, n) => ingest(io, { ...msg, text: undefined, message_id: n + 1, voice: { file_id: `v${n}` } }));
    await vi.waitFor(() => expect(mocks.stt).toHaveBeenCalledTimes(5));
    const response = await io.fetch(new Request('https://intake/flush', { method: 'POST' }));
    expect(await response.json()).toEqual({ preparing: true }); expect(mocks.handle).not.toHaveBeenCalled();
    release(); await Promise.all(pending);
    expect(map.get('buf')).toHaveLength(5);
    await io.fetch(new Request('https://intake/flush', { method: 'POST' }));
    expect(mocks.handle).toHaveBeenCalledTimes(1);
    expect(mocks.handle.mock.calls[0][0].intakeItems.map(i => i.msg.transcript)).toEqual(Array(5).fill('сложная задача'));
  });
  it('photo caption cannot consume file as quick answer; stores a durable file ref, no KV bytes', async () => {
    const { env } = world(); const result = await preflight({ ...msg, photo: [{ file_id: 'p' }] }, env);
    expect(fetch).not.toHaveBeenCalled(); expect(result.msg.fileRef.id).toBe('a'.repeat(64));
    expect(env.SESSIONS.put).not.toHaveBeenCalled();
  });
  it('failed transcription retains original voice for retry at launch', async () => {
    const { io, map } = world(); mocks.stt.mockResolvedValue({ error: 'unavailable' });
    await ingest(io, { ...msg, text: undefined, voice: { file_id: 'v' } });
    expect(map.get('buf')[0].msg.voice.file_id).toBe('v'); expect(map.get('buf')[0].preparingAt).toBeUndefined();
  });
});
