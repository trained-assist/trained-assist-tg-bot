import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #1856 — «Стоп» must also stop the gateway's intake queue, not only a running
// agent process. Prod 29.09: ~7 stops, the agent saw 2 kills; every other stop
// landed between runs and the gateway launched the next buffered batch anyway
// (run-finished → launchAfterRelease, judge debounce alarm, remembered ▶️).
//
// End-to-end through the REAL entry points: routeText + real IntakeBuffer DO +
// real /stop command handler + real ⛔ callback handler. Only Telegram, the agent
// client (stopTask / judge) and the final agent dispatch (handleMessage) are faked.

const tg = [];
let _mid = 500;
const kb = rows => (Array.isArray(rows) ? rows.flat().map(b => b.callback_data).filter(Boolean) : []);
const handleMessage = vi.fn();
const preflight = vi.fn();

vi.mock('../src/handlers/message.js', () => ({ handleMessage: (...a) => handleMessage(...a), processDueRetries: vi.fn() }));
vi.mock('../src/intake-preflight.js', () => ({ preflight: (...a) => preflight(...a) }));
vi.mock('../src/lib/agent-client.js', async original => ({
  ...await original(),
  stopTask: vi.fn().mockResolvedValue({ killed: 0, confirmed: true }),
  runTask: vi.fn().mockResolvedValue({}),
  checkCompleteness: vi.fn().mockResolvedValue({ level: 'clear', complete: true }),
  getProjectDecision: vi.fn().mockResolvedValue({ action: 'auto', choices: [] }),
}));
vi.mock('../src/lib/telegram.js', async original => ({
  ...await original(),
  sendMessage: vi.fn((_t, chatId, text, extra = {}) => {
    tg.push({ kind: 'send', chatId, text, buttons: kb(extra?.reply_markup?.inline_keyboard) });
    return Promise.resolve({ ok: true, result: { message_id: ++_mid } });
  }),
  sendMessageWithKeyboard: vi.fn((_t, chatId, text, rows) => {
    tg.push({ kind: 'send', chatId, text, buttons: kb(rows) });
    return Promise.resolve({ ok: true, result: { message_id: ++_mid } });
  }),
  editMessage: vi.fn((_t, chatId, msgId, text, extra = {}) => {
    tg.push({ kind: 'edit', chatId, msgId, text, buttons: kb(extra?.reply_markup?.inline_keyboard) });
    return Promise.resolve({ ok: true });
  }),
  editMessageReplyMarkup: vi.fn(() => Promise.resolve({ ok: true })),
  deleteMessage: vi.fn(() => Promise.resolve({ ok: true })),
  sendDocument: vi.fn(() => Promise.resolve({ ok: true, result: { message_id: ++_mid } })),
  answerCallbackQuery: vi.fn(() => Promise.resolve({ ok: true })),
  pinChatMessage: vi.fn(() => Promise.resolve({ ok: true })),
  unpinChatMessage: vi.fn(() => Promise.resolve({ ok: true })),
}));

import { routeText } from '../src/index.js';
import { IntakeBuffer } from '../src/intake-buffer.js';
import { handleCallbackQuery } from '../src/handlers/callbacks.js';
import { handleCommand } from '../src/handlers/commands.js';
import { setSession } from '../src/lib/kv.js';
import { stopTask } from '../src/lib/agent-client.js';

function makeState() {
  const map = new Map();
  let alarm = null;
  return { storage: {
    async get(k) { return map.has(k) ? map.get(k) : undefined; },
    async put(k, v) { map.set(k, v); },
    async delete(k) { map.delete(k); },
    async list({ prefix = '' } = {}) { return new Map([...map].filter(([k]) => k.startsWith(prefix))); },
    async transaction(fn) { return fn(this); },
    async getAlarm() { return alarm; },
    async setAlarm(t) { alarm = t; },
    async deleteAlarm() { alarm = null; },
  } };
}

const chatId = 42;
let env, buffers, mid;
const io = () => buffers.get(String(chatId));
const store = () => io().state.storage;
const text = t => ({ message_id: ++mid, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'private' }, from: { id: chatId }, text: t });
const tap = async (data, messageId = 200) => {
  const callbackData = data === 'intake_run' ? `ws|auto|${(await store().get('draftRevision')) || 1}` : data;
  return handleCallbackQuery({ id: `cb-${callbackData}-${Math.random()}`, data: callbackData, from: { id: chatId },
    message: { message_id: messageId, chat: { id: chatId, type: 'private' } } }, env);
};
const stopCmd = (cmd = '/stop') => handleCommand(text(cmd), env);
const drain = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)); };
const runFinished = requestId => io().fetch(new Request('https://intake/run-finished', { method: 'POST', body: JSON.stringify({ requestId }) }));
const lastCollector = () => tg.filter(e => e.buttons.length && /сообщ|ввод|input|задач|собран/i.test(e.text || '')).at(-1);

// Fire the DO alarm as the runtime would at time `at` (ms since epoch).
async function fireAlarmAt(at) {
  vi.setSystemTime(at);
  await io().alarm();
  await drain();
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-29T06:00:00Z'));
  tg.length = 0; mid = 100; buffers = new Map();
  const kv = new Map();
  env = {
    BOT_TOKEN: 't', INTAKE_DEBOUNCE: 'on',
    SESSIONS: {
      get: async (k, o) => (o?.type === 'json' ? JSON.parse(kv.get(k) || 'null') : kv.get(k) ?? null),
      put: async (k, v) => { kv.set(k, v); }, delete: async k => { kv.delete(k); },
      list: async () => ({ keys: [] }),
    },
    INTAKE: { idFromName: n => n, get: name => {
      if (!buffers.has(name)) buffers.set(name, new IntakeBuffer(makeState(), env));
      const b = buffers.get(name);
      return { fetch: (url, init) => b.fetch(new Request(url, init)) };
    } },
  };
  await setSession(env.SESSIONS, chatId, { username: 'owner', activeSessionId: 's-1', lastSessionId: 's-1', lastMessageAt: Date.now() });
  preflight.mockImplementation(async msg => ({ msg }));
  stopTask.mockResolvedValue({ killed: 0, confirmed: true });
  let n = 0;
  handleMessage.mockImplementation(async (msg, _env, opts) => {
    opts?.onRunAccepted?.({ requestId: `req-${++n}`, durable: true, taskId: `task-${n}` });
  });
});
afterEach(() => { vi.useRealTimers(); });

describe('⛔ Стоп holds the intake queue (#1856)', () => {
  it('(a) agent idle, 2 buffered msgs, launchAfterRelease + pending judge timer → no dispatch after 3 s nor after the timer; collector shown', async () => {
    await routeText(text('найди отели в Казани'), env, chatId);
    await routeText(text('и ещё в Самаре'), env, chatId);
    // What the prod chat had armed: a remembered ▶️ and the judge's 30 s timer.
    const judgeAt = Date.now() + 30_000;
    await store().put('launchAfterRelease', true);
    await store().put('launchWhenReady', true);
    await store().put('launchQueued', true);
    await store().put('debounceExpiresAt', judgeAt);
    await store().put('gateLevel', 'continue');
    await store().setAlarm(judgeAt);
    tg.length = 0;

    await stopCmd('/стоп');
    await drain();

    // The stop reached the agent too (it just had nothing running).
    expect(stopTask).toHaveBeenCalledWith(env, expect.objectContaining({ username: 'owner', chatId }));
    // Every launch intent and the judge timer are gone; messages kept.
    for (const k of ['launchAfterRelease', 'launchWhenReady', 'launchQueued', 'debounceExpiresAt', 'gateLevel']) {
      expect(await store().get(k)).toBeUndefined();
    }
    expect(await store().getAlarm()).toBeNull();
    expect((await store().get('buf')).map(i => i.text)).toEqual(['найди отели в Казани', 'и ещё в Самаре']);
    // The collector says so and offers ▶️ (not ↩️) — and no misleading «🤷 нет задач».
    const c = lastCollector();
    expect(c.text).toMatch(/2 сообщений отложены/);
    expect(c.text).toMatch(/статус остановки текущей задачи проверяется отдельно/i);
    expect(c.buttons.length).toBeGreaterThan(0);
    expect(c.buttons).not.toContain('intake_cancel');
    expect(tg.some(e => /Нет активных задач/.test(e.text || ''))).toBe(false);

    // A late run-finished (the agent's push for the killed/finished run) and the
    // alarm firing ~3 s later and after the judge's timer: nothing launches.
    await runFinished('req-old');
    await fireAlarmAt(Date.now() + 3_000);
    await fireAlarmAt(judgeAt + 1_000);
    await fireAlarmAt(judgeAt + 3 * 60_000);
    expect(handleMessage).not.toHaveBeenCalled();
    expect(await store().get('busy')).toBeUndefined();
  });

  it('(b) stop during a run with a queued ▶️ → after run-finished nothing is dispatched', async () => {
    await routeText(text('найди поставщиков'), env, chatId);
    await tap('intake_run');                                  // ▶️ → run starts
    await drain();
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(await store().get('busy')).toBe(true);
    const since = await store().get('busySince');
    await routeText(text('ещё одно'), env, chatId);
    await routeText(text('и ещё'), env, chatId);
    // Tap ▶️ mid-run → remembered for right after the run (launchAfterRelease).
    vi.setSystemTime(since + 5_000);
    await tap('intake_run');
    expect(await store().get('launchAfterRelease')).toBe(true);

    stopTask.mockResolvedValueOnce({ killed: 1, confirmed: true });
    tg.length = 0;
    await stopCmd();
    await drain();
    expect(tg.some(e => /Задача остановлена/.test(e.text || ''))).toBe(true);
    expect(await store().get('launchAfterRelease')).toBeUndefined();

    // The kill makes the agent push run-finished for the running request.
    const res = await (await runFinished('req-1')).json();
    await drain();
    expect(res.released).toBe(true);
    expect(handleMessage).toHaveBeenCalledTimes(1);          // no second run
    expect((await store().get('buf')).map(i => i.text)).toEqual(['ещё одно', 'и ещё']);
    expect(lastCollector().text).toMatch(/2 сообщений отложены/);
    await fireAlarmAt(Date.now() + 5 * 60_000);
    expect(handleMessage).toHaveBeenCalledTimes(1);
  });

  it('(c) ▶️ after a stop dispatches the held batch', async () => {
    await routeText(text('первое'), env, chatId);
    await routeText(text('второе'), env, chatId);
    await stopCmd();
    await drain();
    expect(handleMessage).not.toHaveBeenCalled();

    await tap('intake_run');
    await drain();
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(handleMessage.mock.calls[0][0].text).toBe('первое\nвторое');
    expect(await store().get('stopped')).toBeUndefined();
  });

  it('⛔ button (stopok|) with the agent idle holds the queue and edits the confirm bubble', async () => {
    await routeText(text('задача'), env, chatId);
    await store().put('launchAfterRelease', true);
    tg.length = 0;
    await tap('stopok|task-x', 321);
    await drain();
    expect(stopTask).toHaveBeenCalledTimes(1);
    expect(tg.some(e => e.kind === 'edit' && e.msgId === 321 && /очередь не запустится/.test(e.text))).toBe(true);
    expect(lastCollector().text).toMatch(/1 сообщений отложены/);
    await runFinished('req-z');
    await fireAlarmAt(Date.now() + 10 * 60_000);
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('a stop with nothing buffered and nothing running still says «нет задач»', async () => {
    await stopCmd();
    expect(tg.some(e => /Нет активных задач/.test(e.text || ''))).toBe(true);
  });

  it('a NEW message after the stop re-arms the normal flow, and the collector names the held ones', async () => {
    await routeText(text('старое 1'), env, chatId);
    await routeText(text('старое 2'), env, chatId);
    await stopCmd();
    await drain();
    await routeText(text('новое после стопа'), env, chatId);
    expect(await store().get('stopped')).toBeUndefined();
    expect(await store().get('debounceExpiresAt')).toBeGreaterThan(Date.now());
    await fireAlarmAt(Date.now() + 2_000);                    // receipt
    const c = lastCollector();
    expect(c.text).toMatch(/Получил 3 сообщений/);
    expect(c.text).toMatch(/В том числе 2 — отложенные до ⛔ Стоп/);
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('a message whose preparation was still running when ⛔ was pressed stays held', async () => {
    env.AGENT_URL = 'https://agent';                          // → /ingest path (preflight)
    let finish;
    preflight.mockImplementationOnce(msg => new Promise(r => { finish = () => r({ msg }); }));
    const pending = routeText(text('голосовое до стопа'), env, chatId);
    await drain();
    await stopCmd();
    await drain();
    finish();
    await pending;
    await drain();
    expect(await store().get('stopped')).toBeTruthy();
    expect(await store().get('debounceExpiresAt')).toBeUndefined();
    await fireAlarmAt(Date.now() + 5 * 60_000);
    expect(handleMessage).not.toHaveBeenCalled();
    expect(lastCollector().text).toMatch(/статус остановки текущей задачи проверяется отдельно/i);
  });
});
