import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemKV, makeEnv } from './helpers/p11-helpers.js';

vi.mock('../src/handlers/callbacks.js', () => ({ handleCallbackQuery: vi.fn() }));
vi.mock('../src/lib/telegram.js', () => ({ answerCallbackQuery: vi.fn(), sendMessage: vi.fn(), sendDocument: vi.fn(),
  sendMessageWithKeyboard: vi.fn(), editMessage: vi.fn() }));
import worker from '../src/sandbox-tg/existing-ux.js';
import { handleCallbackQuery } from '../src/handlers/callbacks.js';
import { answerCallbackQuery } from '../src/lib/telegram.js';

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

  it('refuses a changed trusted profile without reusing the existing session', async () => {
    const state = fixture();
    await state.env.SESSIONS.put('isolated-ux:1001', JSON.stringify({ username: 'integrator', controlPlaneProfile: 'other-profile' }));
    expect((await state.send()).status).toBe(403);
    expect(state.collectorCalls).toEqual([]);
  });
});
