import { beforeEach, describe, expect, it, vi } from 'vitest';

// «➕ Дополнить» end-to-end through the REAL entry point: routeText with INTAKE on
// + the REAL IntakeBuffer DO + the REAL callback handler. Only Telegram, the agent
// client and the final agent dispatch (handleMessage) are faked.
//
// Replaces tests/supplement-running-task.test.js (removed in the same PR): that
// test called handleMessage directly without env.INTAKE, i.e. it skipped routeText —
// the very router that swallowed the typed supplement into the intake buffer in
// prod, so it stayed green while the feature never worked (scenario doc K15).
// Scenario: trained-assist-agent docs/user-scenarios/core/02-stop-and-supplement.md
// SS-06 (intercept + confirmation), SS-09 (cancel/expiry/command), SS-10 (burst).

const tg = [];
let _mid = 500;
const kb = rows => (Array.isArray(rows) ? rows.flat().map(b => b.callback_data).filter(Boolean) : []);
const handleMessage = vi.fn();

vi.mock('../src/handlers/message.js', () => ({ handleMessage: (...a) => handleMessage(...a), processDueRetries: vi.fn() }));
vi.mock('../src/handlers/commands.js', () => ({ handleCommand: vi.fn(), isAdminForwardedCommand: () => false,
  cmdFiles: vi.fn(), timeAgo: vi.fn(), renderSessionList: vi.fn() }));
vi.mock('../src/handlers/user-mgmt.js', () => ({ handleUserMgmt: vi.fn(), isUserMgmtCommand: () => false }));
vi.mock('../src/lib/agent-client.js', async original => ({
  ...await original(),
  stopTask: vi.fn().mockResolvedValue({ killed: 1, stopped: true, confirmed: true }),
  runTask: vi.fn().mockResolvedValue({}),
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
}));

import { routeText, dispatchInner } from '../src/index.js';
import { IntakeBuffer } from '../src/intake-buffer.js';
import { handleCallbackQuery } from '../src/handlers/callbacks.js';
import { setSession } from '../src/lib/kv.js';
import { stopTask, runTask } from '../src/lib/agent-client.js';

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
const store = () => buffers.get(String(chatId)).state.storage;
const text = t => ({ message_id: ++mid, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'private' }, from: { id: chatId }, text: t });
const voice = () => ({ message_id: ++mid, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'private' }, from: { id: chatId },
  voice: { file_id: 'v1', file_unique_id: 'u1', duration: 3 } });
const tap = (data, messageId = 200) => handleCallbackQuery({ id: `cb-${data}`, data, from: { id: chatId },
  message: { message_id: messageId, chat: { id: chatId, type: 'private' } } }, env);
const drain = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)); };

beforeEach(async () => {
  vi.clearAllMocks();
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
      const io = buffers.get(name);
      return { fetch: (url, init) => io.fetch(new Request(url, init)) };
    } },
  };
  await setSession(env.SESSIONS, chatId, { username: 'owner', activeSessionId: 's-1', lastSessionId: 's-1', lastMessageAt: Date.now() });
  handleMessage.mockResolvedValue({ ok: true });
});

describe('➕ Дополнить through the real routeText + IntakeBuffer', () => {
  it('SS-06: the typed text is intercepted before the intake buffer and a confirmation appears', async () => {
    await tap('sup|task-abc');
    await routeText(text('учти ещё бюджет'), env, chatId);
    await drain();

    const confirm = tg.filter(e => e.buttons.includes('supok|task-abc'));
    expect(confirm).toHaveLength(1);
    expect(confirm[0].buttons).toEqual(['supno|task-abc', 'supok|task-abc']);
    // Nothing went to the buffer: no collector/«Получил ещё N сообщений», no buffered item.
    expect(await store().get('buf')).toBeUndefined();
    expect(tg.some(e => /Получил/.test(e.text || ''))).toBe(false);
    // The bare text never stops or launches anything.
    expect(stopTask).not.toHaveBeenCalled();
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('SS-10 + SS-07: one confirmation stops and relaunches a burst of text + voice once in the same session', async () => {
    await tap('sup|task-abc');
    await routeText(text('первое'), env, chatId);
    await routeText(text('второе'), env, chatId);
    await routeText(voice(), env, chatId);
    await drain();

    const sends = tg.filter(e => e.kind === 'send' && e.buttons.includes('supok|task-abc'));
    expect(sends).toHaveLength(1);                           // one bubble, not three
    const last = tg.filter(e => e.buttons.includes('supok|task-abc')).at(-1);
    expect(last.text).toContain('3 сообщения');              // edited in place with the live count

    await tap('supok|task-abc', 777);
    await tap('supok|task-abc', 777);                        // a rushed double tap
    await drain();

    expect(stopTask).toHaveBeenCalledTimes(1);
    expect(stopTask).toHaveBeenCalledWith(env, expect.objectContaining({ username: 'owner', chatId }));
    expect(runTask).not.toHaveBeenCalled();                  // no bare runTask bypass any more
    expect(handleMessage).toHaveBeenCalledTimes(1);
    const [msg, , opts] = handleMessage.mock.calls[0];
    expect(msg.intakeRoute).toMatchObject({ sessionId: 's-1', forceNew: false, projectChosen: true });
    expect(msg.intakeItems.map(i => i.text ?? null)).toEqual([
      expect.stringContaining('[Дополнение к задаче'), 'первое', 'второе', null]);
    expect(msg.intakeItems[3].msg.voice).toBeTruthy();       // voice kept → transcribed by handleMessage
    expect(opts).toMatchObject({ mode: 'deep', forceClaude: true, initialMsgId: 777 });
    expect(tg.some(event => /повторно нажимать не нужно/i.test(event.text || ''))).toBe(true);
    // The draft is consumed: the next message is an ordinary one again.
    await routeText(text('новая тема'), env, chatId);
    expect((await store().get('buf'))?.map(i => i.text)).toEqual(['новая тема']);
  });

  it('SS-03: an unconfirmed stop launches nothing and returns the complete draft to ordinary intake', async () => {
    await tap('sup|task-abc');
    await routeText(text('добавка, которую нельзя потерять'), env, chatId);
    stopTask.mockResolvedValueOnce({ killed: 1, stopped: true, confirmed: false });

    await tap('supok|task-abc', 779);
    await tap('supok|task-abc', 779);
    await drain();

    expect(stopTask).toHaveBeenCalledTimes(1);
    expect(handleMessage).not.toHaveBeenCalled();
    expect((await store().get('buf'))?.map(item => item.text)).toContain('добавка, которую нельзя потерять');
    expect(tg.some(e => /Остановка не подтверждена/.test(e.text || ''))).toBe(true);
  });

  it('SS-03: missing stop evidence fails closed; an agent transport error also never starts a run', async () => {
    await tap('sup|task-abc');
    await routeText(text('добавка должна сохраниться'), env, chatId);
    stopTask.mockResolvedValueOnce({ killed: 1 });

    await tap('supok|task-abc', 781);
    await drain();
    expect(handleMessage).not.toHaveBeenCalled();
    expect((await store().get('buf'))?.map(item => item.text)).toContain('добавка должна сохраниться');

    await tap('sup|task-abc');
    await routeText(text('ещё одно дополнение'), env, chatId);
    stopTask.mockRejectedValueOnce(new Error('agent unreachable'));
    await tap('supok|task-abc', 782);
    await drain();
    expect(handleMessage).not.toHaveBeenCalled();
    expect((await store().get('buf'))?.map(item => item.text)).toContain('ещё одно дополнение');
  });

  it('SS-08: if the old task has already finished, the same confirmation launches one continuation', async () => {
    await tap('sup|task-abc');
    await routeText(text('продолжение после завершения'), env, chatId);
    stopTask.mockResolvedValueOnce({ killed: 0, stopped: false, confirmed: true });

    await tap('supok|task-abc', 780);
    await drain();

    expect(stopTask).toHaveBeenCalledTimes(1);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(handleMessage.mock.calls[0][0].intakeRoute).toMatchObject({ sessionId: 's-1', forceNew: false });
    expect(tg.some(e => /уже завершилась/.test(e.text || ''))).toBe(true);
  });

  it('SS-09: ↩️ Вернуться drops the draft, leaves the task alone and returns the text to the intake flow', async () => {
    await tap('sup|task-abc');
    await routeText(text('передумал'), env, chatId);
    await tap('supno|task-abc', 778);
    await drain();

    expect(stopTask).not.toHaveBeenCalled();
    expect(handleMessage).not.toHaveBeenCalled();
    expect((await store().get('buf'))?.map(i => i.text)).toEqual(['передумал']);
    expect(tg.some(e => e.kind === 'edit' && /Дополнение отменено/.test(e.text || ''))).toBe(true);
    expect(await store().get('supplement')).toBeUndefined();
  });

  it('SS-09: an expired draft stops intercepting — the collected and the new message go to the normal flow', async () => {
    await tap('sup|task-abc');
    await routeText(text('написал'), env, chatId);
    const draft = await store().get('supplement');
    await store().put('supplement', { ...draft, expiresAt: Date.now() - 1 });

    await routeText(text('через час'), env, chatId);
    expect((await store().get('buf'))?.map(i => i.text)).toEqual(['написал', 'через час']);
    expect(await store().get('supplement')).toBeUndefined();
    expect(stopTask).not.toHaveBeenCalled();
  });

  it('SS-09: a command while armed cancels the supplement and says so', async () => {
    await tap('sup|task-abc');
    await routeText(text('черновик'), env, chatId);
    tg.length = 0;
    await dispatchInner({ update_id: 1, message: text('/status') }, env);
    await drain();

    expect(await store().get('supplement')).toBeUndefined();
    expect((await store().get('buf'))?.map(i => i.text)).toEqual(['черновик']);
    expect(tg.some(e => /Дополнение отменено/.test(e.text || ''))).toBe(true);
    expect(stopTask).not.toHaveBeenCalled();
  });

  it('without a tap, text still buffers normally (no regression of the intake rule)', async () => {
    await routeText(text('просто сообщение'), env, chatId);
    expect((await store().get('buf'))?.map(i => i.text)).toEqual(['просто сообщение']);
    expect(tg.some(e => e.buttons.includes('supok|task-abc'))).toBe(false);
  });
});
