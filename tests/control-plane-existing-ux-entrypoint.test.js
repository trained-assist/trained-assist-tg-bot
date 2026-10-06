import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemKV, makeEnv } from './helpers/p11-helpers.js';

vi.mock('../src/handlers/callbacks.js', () => ({ handleCallbackQuery: vi.fn() }));
vi.mock('../src/lib/telegram.js', () => ({ answerCallbackQuery: vi.fn(), sendMessage: vi.fn(), sendDocument: vi.fn(),
  sendMessageWithKeyboard: vi.fn(), editMessage: vi.fn() }));
import worker from '../src/sandbox-tg/existing-ux.js';
import { handleCallbackQuery } from '../src/handlers/callbacks.js';
import { answerCallbackQuery } from '../src/lib/telegram.js';
import { sha256Hex } from '../src/ingress-buffer/worker.js';

function fixture() {
  const collectorCalls = [];
  const env = makeEnv({ SESSIONS: new MemKV(), TG_SLICE: new MemKV(), TG_SLICE_ALLOWED_USERS: '7',
    SESSION_NAMESPACE: 'isolated-ux', INTAKE_DEBOUNCE: 'on' });
  env.INTAKE = { idFromName: name => name, get: name => ({ async fetch(url, options) {
    collectorCalls.push({ name, url, body: JSON.parse(options.body) });
    return Response.json({ appended: true });
  } }) };
  const update = { update_id: 1, message: { message_id: 11, date: Math.floor(Date.now() / 1000),
    chat: { id: 1001, type: 'private' }, from: { id: 7 }, text: 'работает?' } };
  const send = (body = update, secret = env.TELEGRAM_WEBHOOK_SECRET) => worker.fetch(new Request('https://worker/webhook', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret }, body: JSON.stringify(body),
  }), env);
  return { env, update, send, collectorCalls };
}

beforeEach(() => vi.clearAllMocks());

describe('signed existing-UX ingress', () => {
  it('protects operator reconciliation and reuses the scheduled controller', async () => {
    const state = fixture();
    expect((await worker.fetch(new Request('https://worker/cron'), state.env)).status).toBe(401);
    const response = await worker.fetch(new Request('https://worker/cron', {
      headers: { 'x-telegram-bot-api-secret-token': state.env.TELEGRAM_WEBHOOK_SECRET },
    }), state.env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ reconciled: true, pushed: [] });
    expect(state.collectorCalls).toEqual([]);
  });

  it('refuses unsigned or foreign collector-state reads', async () => {
    const state = fixture();
    expect((await worker.fetch(new Request('https://worker/collector-state?chatId=1001'), state.env)).status).toBe(401);
    expect((await worker.fetch(new Request('https://worker/collector-state?chatId=9999', {
      headers: { 'x-telegram-bot-api-secret-token': state.env.TELEGRAM_WEBHOOK_SECRET },
    }), state.env)).status).toBe(403);
    expect(state.collectorCalls).toEqual([]);
  });

  it('stores ordinary input only in the separate collector', async () => {
    const state = fixture();
    expect((await state.send()).status).toBe(200);
    expect(state.collectorCalls).toEqual([{ name: '1001', url: 'https://intake/append',
      body: { text: 'работает?', msg: state.update.message, flush: false, telegramUpdateId: 1 } }]);
    expect(handleCallbackQuery).not.toHaveBeenCalled();
    expect(await state.env.SESSIONS.get('1001')).toBeNull();
    expect(JSON.parse(await state.env.SESSIONS.get('isolated-ux:1001')).controlPlaneProfile).toBe('profile-1');
  });

  it('stores Telegram file bytes in ingress and appends only the immutable manifest', async () => {
    const state = fixture();
    const bytes = new TextEncoder().encode('sample audio');
    const digest = await sha256Hex(bytes);
    let bufferRequest;
    state.env.MEDIA_PIPELINE = 'ingress-buffer';
    state.env.INGRESS_BUFFER_TOKEN = 'buffer-secret';
    state.env.INGRESS_BUFFER = { async fetch(url, options) {
      bufferRequest = { url, options };
      return Response.json({ manifest: { contractVersion: 1, ref: options.headers['x-artifact-ref'], version: digest,
        ownerProfileId: options.headers['x-artifact-owner-profile-id'], mediaType: options.headers['content-type'],
        name: 'voice.ogg', sizeBytes: bytes.byteLength, sha256: digest } }, { status: 201 });
    } };
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async url => String(url).includes('/getFile')
      ? Response.json({ ok: true, result: { file_path: 'voice.ogg', file_size: bytes.byteLength } })
      : new Response(bytes)));
    const update = { update_id: 3, message: { message_id: 13, date: 1, chat: { id: 1001, type: 'private' },
      from: { id: 7 }, caption: 'transcribe this', voice: { file_id: 'telegram-file-id', file_size: bytes.byteLength } } };
    try {
      expect((await state.send(update)).status).toBe(200);
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }
    const appended = state.collectorCalls[0].body.msg;
    expect(bufferRequest.url).toBe('https://ingress-buffer/v1/artifacts');
    expect(new TextDecoder().decode(bufferRequest.options.body)).toBe('sample audio');
    expect(appended).toMatchObject({ caption: 'transcribe this', fileRef: { storage: 'ingress', name: 'voice.ogg' },
      ingressArtifactManifest: { ownerProfileId: 'profile-1', mediaType: 'audio/ogg', sha256: digest } });
    expect(appended.voice).toBeUndefined();
    expect(JSON.stringify(state.collectorCalls)).not.toContain('telegram-file-id');
  });

  it('fails closed when media storage is off or unavailable', async () => {
    const state = fixture();
    const update = { update_id: 4, message: { message_id: 14, date: 1, chat: { id: 1001, type: 'private' },
      from: { id: 7 }, voice: { file_id: 'telegram-file-id' } } };
    expect((await state.send(update)).status).toBe(503);
    state.env.MEDIA_PIPELINE = 'ingress-buffer';
    state.env.INGRESS_BUFFER_TOKEN = 'buffer-secret';
    state.env.INGRESS_BUFFER = { fetch: async () => { throw new Error('unavailable'); } };
    expect((await state.send({ ...update, update_id: 5 })).status).toBe(503);
    expect(state.collectorCalls).toEqual([]);
  });

  it('refuses unsigned ingress before collector and session mutations', async () => {
    const state = fixture();
    expect((await state.send(state.update, 'wrong')).status).toBe(401);
    expect(state.collectorCalls).toEqual([]);
    expect(state.env.SESSIONS.data.size).toBe(0);
  });

  it('refuses foreign callback users even in the allowed chat', async () => {
    const state = fixture();
    const update = { update_id: 2, callback_query: { id: 'foreign', data: 'intake_run', from: { id: 8 }, message: state.update.message } };
    expect((await state.send(update)).status).toBe(403);
    expect(handleCallbackQuery).not.toHaveBeenCalled();
    expect(state.collectorCalls).toEqual([]);
  });

  it('does not send unsupported legacy callbacks to legacy execution', async () => {
    const state = fixture();
    const update = { update_id: 2, callback_query: { id: 'owned', data: 'sp:old-session', from: { id: 7 }, message: state.update.message } };
    const response = await state.send(update);
    expect(await response.json()).toMatchObject({ ok: true, unsupported: true });
    expect(handleCallbackQuery).not.toHaveBeenCalled();
    expect(answerCallbackQuery).toHaveBeenCalledWith(state.env.TG_SANDBOX_BOT_TOKEN, 'owned', expect.stringContaining('ещё не подключена'));
  });

  it('does not expose native stop before exit provenance is accepted', async () => {
    const state = fixture();
    const update = { update_id: 2, callback_query: { id: 'owned', data: 'intake_stopyes|supp', from: { id: 7 }, message: state.update.message } };
    const response = await state.send(update);
    expect(await response.json()).toMatchObject({ ok: true, unsupported: true });
    expect(handleCallbackQuery).not.toHaveBeenCalled();
    expect(state.collectorCalls).toEqual([]);
  });

  it('refuses a changed trusted profile without reusing the existing session', async () => {
    const state = fixture();
    await state.env.SESSIONS.put('isolated-ux:1001', JSON.stringify({ username: 'integrator', controlPlaneProfile: 'other-profile' }));
    expect((await state.send()).status).toBe(403);
    expect(state.collectorCalls).toEqual([]);
  });
});
