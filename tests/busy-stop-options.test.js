import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Ф3 / RC-04 / RC-05 (trained-agent-architecture scenarios/interaction/
// run-conflict-explicit-choice.md, tg-bot#316): the two stop options of the busy
// menu and the «silence must not start it» rule.
//
// End-to-end through the REAL entry points: routeText + real IntakeBuffer DO +
// real callback handler. Only Telegram, the agent client and the final dispatch
// (handleMessage) are faked.

const tg = [];
let _mid = 700;
const kb = rows => (Array.isArray(rows) ? rows.flat().map(b => b.callback_data).filter(Boolean) : []);
const handleMessage = vi.fn();
const preflight = vi.fn();

vi.mock('../src/handlers/message.js', () => ({ handleMessage: (...a) => handleMessage(...a), processDueRetries: vi.fn() }));
vi.mock('../src/intake-preflight.js', () => ({ preflight: (...a) => preflight(...a) }));
vi.mock('../src/lib/agent-client.js', async original => ({
  ...await original(),
  stopTask: vi.fn().mockResolvedValue({ killed: 1 }),
  runTask: vi.fn().mockResolvedValue({}),
  checkCompleteness: vi.fn().mockResolvedValue({ level: 'clear', complete: true }),
  getProjectDecision: vi.fn().mockResolvedValue({ action: 'auto', choices: [] }),
  checkRunActive: vi.fn().mockResolvedValue({ running: false }),
}));
vi.mock('../src/lib/telegram.js', async original => ({
  ...await original(),
  sendMessage: vi.fn((_t, chatId, text, extra = {}) => {
    tg.push({ kind: 'send', chatId, text, buttons: kb(extra?.reply_markup?.inline_keyboard) });
    return Promise.resolve({ ok: true, result: { message_id: ++_mid } });
  }),
  sendMessageWithKeyboard: vi.fn((_t, chatId, text, rows) => {
    const id = ++_mid;
    tg.push({ kind: 'send', chatId, msgId: id, text, buttons: kb(rows) });
    return Promise.resolve({ ok: true, result: { message_id: id } });
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
let env, buffers, mid, startedAt;
const io = () => buffers.get(String(chatId));
const store = () => io().state.storage;
const text = t => ({ message_id: ++mid, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'private' }, from: { id: chatId }, text: t });
const tap = (data, messageId = 900) => handleCallbackQuery({ id: `cb-${data}-${Math.random()}`, data, from: { id: chatId },
  message: { message_id: messageId, chat: { id: chatId, type: 'private' } } }, env);
const drain = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0)); };
const runFinished = (requestId = 'req-1') => io().fetch(new Request('https://intake/run-finished', { method: 'POST', body: JSON.stringify({ requestId }) }));
const menuButton = name => tg.filter(e => e.buttons.includes(name)).at(-1);
const say = t => tg.filter(e => e.text?.includes(t)).at(-1);
// Fire the DO alarm as the runtime would at time `at` (ms since epoch).
async function fireAlarmAt(at) {
  vi.setSystemTime(at);
  await io().alarm();
  await drain();
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  startedAt = new Date('2026-10-02T10:00:00Z');
  vi.setSystemTime(startedAt);
  tg.length = 0; mid = 100; buffers = new Map();
  const kv = new Map();
  env = {
    BOT_TOKEN: 't', INTAKE_DEBOUNCE: 'on', AGENT_URL: 'http://agent', AGENT_SECRET: 's',
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
  stopTask.mockResolvedValue({ killed: 1 });
  let n = 0;
  handleMessage.mockImplementation(async (msg, _env, opts) => {
    opts?.onRunAccepted?.({ requestId: `req-${++n}`, durable: true, taskId: `task-${n}` });
  });
});
afterEach(() => { vi.useRealTimers(); });

// A run A is in flight and one message arrived during it: the busy menu with all
// four explicit choices is on the receipt.
async function busyWindow() {
  await routeText(text('первая задача'), env, chatId);
  await drain();
  await tap('intake_run', 300);
  await drain();
  await routeText(text('уточнение по первой задаче'), env, chatId);
  await drain();
  await fireAlarmAt(Date.now() + 2000); // the receipt alarm paints the busy menu
}

describe('Ф3 busy menu — the two stop options (RC-04/RC-05)', () => {
  it('the busy receipt offers all four choices, incl. both stop options', async () => {
    await busyWindow();
    const menu = menuButton('intake_stopsupp');
    expect(menu).toBeTruthy();
    expect(menu.buttons).toEqual(expect.arrayContaining(['intake_run', 'intake_parallel', 'intake_stopsupp', 'intake_stopnew']));
  });

  it('a stop tap only ASKS (SS-01): no stop, no run, one confirm bubble', async () => {
    await busyWindow();
    const before = handleMessage.mock.calls.length;
    await tap('intake_stopsupp', menuButton('intake_stopsupp').msgId ?? 901);
    await drain();
    expect(stopTask).not.toHaveBeenCalled();
    expect(handleMessage.mock.calls.length).toBe(before);
    expect(say('Остановить текущую задачу и сразу продолжить её')).toBeTruthy();
  });

  it('«↩️ Вернуться» cancels the question: task keeps running, batch waits', async () => {
    await busyWindow();
    await tap('intake_stopsupp', 901);
    await drain();
    await tap('intake_stopno|supp', 902);
    await drain();
    expect(stopTask).not.toHaveBeenCalled();
    expect(say('Остановка отменена')).toBeTruthy();
    expect(await store().get('stopLaunch')).toBeUndefined();
  });

  it('RC-04: stop + continue the SAME task — one run, supplement marker first, no stop duplicate', async () => {
    await busyWindow();
    const runsBefore = handleMessage.mock.calls.length;
    await tap('intake_stopsupp', 901);
    await drain();
    await tap('intake_stopyes|supp', 902);
    await drain();
    // Stop happened once (hold + kill), and nothing was launched yet: the killed
    // run's own run-finished is what frees the busy window.
    expect(stopTask).toHaveBeenCalledTimes(1);
    expect(handleMessage.mock.calls.length).toBe(runsBefore);
    expect(await store().get('stopLaunch')).toMatchObject({ mode: 'supp' });

    await runFinished();
    await drain();
    expect(handleMessage.mock.calls.length).toBe(runsBefore + 1); // ровно один ран
    const sent = handleMessage.mock.calls.at(-1);
    const items = sent[0].intakeItems;
    expect(items[0].text).toContain('Дополнение к задаче');
    expect(sent[0].intakeRoute).toMatchObject({ sessionId: 's-1', forceNew: false });
    expect(await store().get('stopLaunch')).toBeUndefined();
    expect(await store().get('buf')).toBeFalsy();      // порция ушла, дубля не осталось
    expect(await store().get('busy')).toBe(true);      // новая задача держит окно сама
  });

  it('RC-05: stop + NEW task — one run, no supplement marker, no pinned session', async () => {
    await busyWindow();
    await tap('intake_stopnew', 901);
    await drain();
    await tap('intake_stopyes|new', 902);
    await drain();
    await runFinished();
    await drain();
    const sent = handleMessage.mock.calls.at(-1);
    expect(sent[0].intakeItems[0].text).not.toContain('Дополнение к задаче');
    expect(sent[0].intakeRoute ?? null).toBeFalsy();
    expect(handleMessage).toHaveBeenCalledTimes(2); // первый ран + один новый
  });

  it('F3: the run had already finished — the stop degrades to an ordinary launch, one run', async () => {
    await busyWindow();
    await runFinished();
    await drain();
    stopTask.mockResolvedValue({ killed: 0 });
    await tap('intake_stopnew', 901);
    await drain();
    await tap('intake_stopyes|new', 902);
    await drain();
    expect(handleMessage).toHaveBeenCalledTimes(2);
    expect(say('Задача уже завершалась')).toBeTruthy();
  });

  it('F2: a double confirm does not start a second run', async () => {
    await busyWindow();
    await tap('intake_stopsupp', 901);
    await drain();
    await tap('intake_stopyes|supp', 902);
    await drain();
    await tap('intake_stopyes|supp', 902);
    await drain();
    await runFinished();
    await drain();
    expect(handleMessage).toHaveBeenCalledTimes(2); // один ран после остановки
    expect(say('Уже выполняется')).toBeTruthy();
  });

  it('F7: an unconfirmed stop launches nothing and says so', async () => {
    await busyWindow();
    stopTask.mockRejectedValue(new Error('agent unreachable'));
    await tap('intake_stopsupp', 901);
    await drain();
    await tap('intake_stopyes|supp', 902);
    await drain();
    await runFinished();
    await drain();
    expect(handleMessage).toHaveBeenCalledTimes(1); // только первый ран
    expect(await store().get('stopLaunch')).toBeUndefined();
    expect(say('Не удалось подтвердить остановку')).toBeTruthy();
  });

  it('«↩️ Отменить передачу агенту» cancels a pending stop+launch and says the task stays stopped', async () => {
    await busyWindow();
    await tap('intake_stopsupp', 901);
    await drain();
    await tap('intake_stopyes|supp', 902);
    await drain();
    await tap('intake_cancel', 903);
    await drain();
    expect(await store().get('stopLaunch')).toBeUndefined();
    await runFinished();
    await drain();
    expect(handleMessage).toHaveBeenCalledTimes(1); // порция не ушла
    expect(say('Задача при этом осталась остановленной')).toBeTruthy();
  });
});

describe('RC-06 — nothing starts out of the busy window on its own', () => {
  it('a message held during a run waits 15 minutes after the run ends: no dispatch, no timer', async () => {
    await busyWindow();
    await runFinished();
    await drain();
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(await store().get('debounceExpiresAt')).toBeUndefined(); // тишина-гейт не armed
    for (let min = 1; min <= 15; min++) await fireAlarmAt(startedAt.getTime() + min * 60_000);
    expect(handleMessage).toHaveBeenCalledTimes(1); // ни одного автозапуска за 15 мин
    expect(menuButton('intake_run')).toBeTruthy();   // меню/кнопка остались у пользователя
  });

  it('a NEW message after the release returns the chat to the ordinary auto-start', async () => {
    await busyWindow();
    await runFinished();
    await drain();
    await routeText(text('а теперь отдельная задача'), env, chatId);
    await drain();
    expect(await store().get('debounceExpiresAt')).toBeTruthy();
  });
});
