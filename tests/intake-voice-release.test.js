import { describe, it, expect, vi, afterEach } from 'vitest';
import { dispatchInner } from '../src/index.js';
import { IntakeBuffer } from '../src/intake-buffer.js';

// Real dispatch → DO → preparation → Telegram download → STT → quick client.
// Only external HTTP and durable storage are substituted, never internal handlers.
function world(answer = { answer: 'https://review.example', sessionId: 'qa-test' }) {
  const stored = new Map(); const sent = []; const requests = []; const events = [];
  const session = { username: 'alice', lastSessionId: 'deep-original', allMsgMode: false };
  const env = { AGENT_URL: 'https://agent.test', AGENT_SECRET: 'secret', BOT_TOKEN: 'test',
    BOT_USERNAME: 'test_bot', DEEPGRAM_API_KEY: 'test', INTAKE_DEBOUNCE: 'on',
    SESSIONS: { get: async k => k.startsWith('mc:') ? { count: 3, ts: Date.now() } : JSON.stringify(session), put: vi.fn() } };
  const storage = { get: async k => stored.get(k), put: async (k,v) => stored.set(k,v), delete: async k => stored.delete(k) };
  const buffer = new IntakeBuffer({ storage }, env);
  env.INTAKE = { idFromName: n => n, get: () => ({ fetch: (url, init) => buffer.fetch(new Request(url, init)) }) };
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const u = String(url); requests.push(u);
    if (u.includes('/getFile?')) return Response.json({ ok: true, result: { file_path: 'voice.ogg' } });
    if (u.includes('/file/bot')) return new Response(new Uint8Array([1,2,3]));
    if (u.includes('api.deepgram.com/')) { events.push('stt'); return Response.json({ results: { channels: [{ alternatives: [{ transcript: 'Покажи ссылку для ревью кандидатов' }] }] } }); }
    if (u.endsWith('/intake-quick')) {
      events.push('quick'); expect(JSON.parse(init.body).query).toContain('Покажи ссылку для ревью кандидатов');
      return answer instanceof Response ? answer : Response.json(answer);
    }
    if (u.includes('/sendMessage')) { const body = JSON.parse(init.body); sent.push(body); events.push(body.text.startsWith('🎤') ? 'transcript' : 'send'); return Response.json({ ok: true, result: { message_id: sent.length + 100 } }); }
    if (u.includes('/editMessageReplyMarkup')) return Response.json({ ok: true });
    throw new Error(`Unexpected HTTP request: ${u}`);
  }));
  return { env, stored, sent, requests, events };
}
const voice = (mode) => ({ message: { message_id: 1, date: Math.floor(Date.now()/1000),
  from: { id: 7 }, chat: { id: mode === 'private' ? 42 : -42, type: mode === 'private' ? 'private' : 'supergroup' },
  voice: { file_id: 'voice', mime_type: 'audio/ogg' },
  ...(mode === 'reply' ? { reply_to_message: { from: { username: 'test_bot' } } } : {}),
  ...(mode === 'mention' ? { caption: '@test_bot' } : {}) } });
afterEach(() => vi.unstubAllGlobals());
describe('voice quick answer release contract', () => {
  for (const mode of ['private', 'reply', 'mention']) {
    it(`${mode}: transcript then validated quick hit, no collector or full run`, async () => {
      const w = world(); await dispatchInner(voice(mode), w.env);
      expect(w.events.slice(0,3)).toEqual(['stt', 'transcript', 'quick']);
      expect(w.sent.map(m => m.text)).toEqual(['🎤 Покажи ссылку для ревью кандидатов', '⚡ https://review.example']);
      expect(w.stored.get('buf')).toEqual([]);
      expect(w.requests.some(u => u.endsWith('/run'))).toBe(false);
      expect(w.sent[1].reply_markup.inline_keyboard[0][0].callback_data).toBe('qa_more|qa-test');
    });
    it(`${mode}: intent rejection preserves transcript for collection`, async () => {
      const w = world({ answer: null }); await dispatchInner(voice(mode), w.env);
      expect(w.stored.get('buf')).toHaveLength(1);
      expect(w.stored.get('buf')[0].msg.transcript).toContain('ревью кандидатов');
      expect(w.sent.at(-1).text).toContain('Накапливаю');
      if (mode === 'reply') expect(w.stored.get('buf')[0].msg.intakeRoute.sessionId).toBe('deep-original');
    });
  }
  it('a missing backend endpoint preserves the voice instead of pretending to answer', async () => {
    const w = world(new Response('', { status: 404 })); await dispatchInner(voice('private'), w.env);
    expect(w.stored.get('buf')).toHaveLength(1); expect(w.sent.at(-1).text).toContain('Накапливаю');
  });
  it('large all_off group human-to-human voice does not transcribe or answer', async () => {
    const w = world(); await dispatchInner(voice('ambient'), w.env);
    expect(w.requests).toEqual([]); expect(w.sent).toEqual([]);
  });
});
