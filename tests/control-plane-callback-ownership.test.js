import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/kv.js', () => ({
  getSession: vi.fn(), setSession: vi.fn(), deleteSession: vi.fn(), newSessionId: vi.fn(),
  withKvConsistencyRetry: vi.fn(),
}));
vi.mock('../src/lib/telegram.js', () => ({
  answerCallbackQuery: vi.fn(), sendMessage: vi.fn(), sendMessageWithKeyboard: vi.fn(),
  sendDocument: vi.fn(), editMessage: vi.fn(), editMessageReplyMarkup: vi.fn(),
  pinChatMessage: vi.fn(), unpinChatMessage: vi.fn(),
  deleteMessage: vi.fn(),
}));
vi.mock('../src/lib/agent-client.js', () => ({
  runTask: vi.fn(), getSessions: vi.fn(), readFile: vi.fn(), archiveSessions: vi.fn(),
  getProjects: vi.fn(), stopTask: vi.fn(), fetchRunInput: vi.fn(), orphanChecklistAction: vi.fn(),
  checkCompleteness: vi.fn(),
}));
vi.mock('../src/handlers/message.js', () => ({ handleMessage: vi.fn() }));
vi.mock('../src/lib/stop-chat.js', () => ({ stopChat: vi.fn(), stopReplyText: vi.fn() }));
vi.mock('../src/handlers/commands.js', () => ({ cmdFiles: vi.fn(), timeAgo: vi.fn(), renderSessionList: vi.fn() }));

import { controlPlaneCallbackOwned, handleCallbackQuery } from '../src/handlers/callbacks.js';
import { getSession, setSession } from '../src/lib/kv.js';
import { answerCallbackQuery, editMessage, sendDocument, sendMessage, sendMessageWithKeyboard } from '../src/lib/telegram.js';
import { fetchRunInput, runTask } from '../src/lib/agent-client.js';
import { stopChat } from '../src/lib/stop-chat.js';
import { IntakeBuffer } from '../src/intake-buffer.js';

const session = { username: 'fixture-user', activeSessionId: 'fixture-session' };
const actions = ['intake_run', 'intake_parallel', 'intake_cancel', 'workrun|old',
  'intake_stopsupp', 'intake_stopnew', 'intake_stopyes|supp', 'intake_stopno|new',
  'stop|task', 'stopok|task', 'stopno|task'];
function callback(data, messageId = 42, threadId = null) {
  return { id: 'fixture-callback', data, from: { id: 7 },
    message: { message_id: messageId, chat: { id: 7 },
      ...(threadId ? { message_thread_id: threadId, is_topic_message: true } : {}) } };
}
function environment(owned = false) {
  const fetch = vi.fn(async url => new Response(JSON.stringify(url.endsWith('/callback-owner')
    ? { owned } : { flushed: true, cancelled: true, items: [{}] }), { status: 200 }));
  const env = { EXECUTION_BACKEND: 'control-plane', BOT_TOKEN: 'fixture-token', SESSIONS: {},
    INTAKE: { idFromName: vi.fn(name => name), get: vi.fn(() => ({ fetch })) } };
  return { env, fetch };
}

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue(session);
  editMessage.mockResolvedValue({});
  sendMessage.mockResolvedValue({});
  sendMessageWithKeyboard.mockResolvedValue({});
  stopChat.mockResolvedValue({ killed: 0, held: 1, error: new Error('stop_unconfirmed') });
});

describe('CP source-message ownership', () => {
  it('CP snapshot preview names frozen CP input and never fetches legacy model prompt', async () => {
    const { env, fetch } = environment();
    fetch.mockResolvedValue(Response.json({ state: 'snapshot', id: 'cp-request', body: { task: 'fixture task' }, items: [] }));
    await handleCallbackQuery(callback('input_run'), env);
    expect(fetchRunInput).not.toHaveBeenCalled();
    expect(sendDocument).toHaveBeenCalledWith('fixture-token', 7, 'input-snapshot.txt', expect.any(String),
      'Зафиксированный ввод Control Plane — cp-request. Это не полный prompt модели.', null);
  });

  it('CP draft preview does not promise future model input', async () => {
    const { env, fetch } = environment();
    fetch.mockResolvedValue(Response.json({ state: 'draft', task: 'fixture task', items: [], pending: false }));
    await handleCallbackQuery(callback('input_draft'), env);
    expect(fetchRunInput).not.toHaveBeenCalled();
    expect(sendDocument.mock.calls[0][4]).toContain('Черновик ввода Control Plane');
    expect(sendDocument.mock.calls[0][4]).not.toContain('агент');
  });

  for (const data of ['input_journal', 'input_journal|42|legacy-session']) it(`unsupported CP ${data} never builds legacy journal link`, async () => {
    const { env, fetch } = environment();
    await handleCallbackQuery(callback(data), env);
    expect(fetch).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(answerCallbackQuery).toHaveBeenCalledWith('fixture-token', 'fixture-callback', 'Журнал Control Plane пока недоступен.');
  });
  for (const data of actions) it(`rejects stale ${data} before any action`, async () => {
    const { env, fetch } = environment();
    await handleCallbackQuery(callback(data), env);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('https://intake/callback-owner');
    expect(answerCallbackQuery).toHaveBeenCalledWith('fixture-token', 'fixture-callback', expect.stringContaining('устарела'));
    expect(runTask).not.toHaveBeenCalled();
    expect(stopChat).not.toHaveBeenCalled();
    expect(setSession).not.toHaveBeenCalled();
    expect(editMessage).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendMessageWithKeyboard).not.toHaveBeenCalled();
  });

  for (const data of ['intake_run', 'intake_parallel', 'intake_cancel']) it(`current ${data} carries source for atomic DO recheck`, async () => {
    const { env, fetch } = environment(true);
    await handleCallbackQuery(callback(data, 42, 9), env);
    expect(env.INTAKE.idFromName).toHaveBeenCalledWith('7:9');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ messageId: 42, callbackData: data, username: session.username });
    const mutation = fetch.mock.calls.find(([url]) => url.endsWith(data === 'intake_cancel' ? '/cancel' : '/flush'));
    expect(JSON.parse(mutation[1].body)).toEqual({ sourceMessageId: 42, callbackData: data, username: session.username,
      ...(data === 'intake_cancel' ? {} : { parallel: data === 'intake_parallel' }) });
  });

  for (const status of [403, 404, 409, 500]) it(`ownership HTTP${status} fails closed`, async () => {
    const { env, fetch } = environment(true);
    fetch.mockResolvedValue(new Response('{}', { status }));
    expect(await controlPlaneCallbackOwned(callback('intake_run'), env, session)).toBe(false);
  });

  it('network, invalid JSON and truthy nonboolean approval fail closed', async () => {
    const { env, fetch } = environment(true);
    fetch.mockRejectedValueOnce(new Error('offline'));
    expect(await controlPlaneCallbackOwned(callback('intake_run'), env, session)).toBe(false);
    fetch.mockResolvedValueOnce(new Response('invalid'));
    expect(await controlPlaneCallbackOwned(callback('intake_run'), env, session)).toBe(false);
    fetch.mockResolvedValueOnce(new Response('{"owned":"true"}'));
    expect(await controlPlaneCallbackOwned(callback('intake_run'), env, session)).toBe(false);
  });

  it('missing binding, owner or valid source message fails closed', async () => {
    const { env, fetch } = environment(true);
    expect(await controlPlaneCallbackOwned(callback('intake_run'), { ...env, INTAKE: null }, session)).toBe(false);
    expect(await controlPlaneCallbackOwned(callback('intake_run'), env, null)).toBe(false);
    for (const messageId of [null, 0, -1, '42']) expect(await controlPlaneCallbackOwned(callback('intake_run', messageId), env, session)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('non-forum reply roots do not cross conversation ownership', async () => {
    const { env } = environment(true);
    const cq = callback('intake_run');
    cq.message.message_thread_id = 99;
    await controlPlaneCallbackOwned(cq, env, session);
    expect(env.INTAKE.idFromName).toHaveBeenCalledWith('7');
  });

  it('legacy backend has no ownership endpoint dependency', async () => {
    const { env, fetch } = environment(false);
    delete env.EXECUTION_BACKEND;
    await handleCallbackQuery(callback('intake_run'), env);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('https://intake/flush');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ parallel: false });
  });

  it('atomic flush refusal does not announce accepted queue or parallel launch', async () => {
    const { env, fetch } = environment(true);
    fetch.mockImplementation(async url => url.endsWith('/callback-owner')
      ? Response.json({ owned: true }) : new Response('{"parallel":true,"queued":true}', { status: 409 }));
    await handleCallbackQuery(callback('intake_parallel'), env);
    expect(sendMessage.mock.calls.every(call => !String(call[2]).includes('Запускаю параллельно'))).toBe(true);
    expect(runTask).not.toHaveBeenCalled();
  });

  it('atomic cancel refusal cannot claim cancellation from an error body', async () => {
    const { env, fetch } = environment(true);
    fetch.mockImplementation(async url => url.endsWith('/callback-owner')
      ? Response.json({ owned: true }) : new Response('{"cancelled":true}', { status: 409 }));
    await handleCallbackQuery(callback('intake_cancel'), env);
    expect(sendMessage.mock.calls.some(call => String(call[2]).includes('Отмена передачи не подтверждена'))).toBe(true);
    expect(sendMessage.mock.calls.some(call => String(call[2]).includes('Передача отменена'))).toBe(false);
  });

  it('CP stop error never claims running task stopped', async () => {
    const { env } = environment(true);
    await handleCallbackQuery(callback('stopok|task'), env);
    expect(editMessage).toHaveBeenCalledWith('fixture-token', 7, 42, '⚠️ Остановка задачи не подтверждена.', expect.anything());
  });

  it('unconfirmed stop-and-launch never launches held input', async () => {
    const { env, fetch } = environment(true);
    await handleCallbackQuery(callback('intake_stopyes|supp'), env);
    expect(fetch.mock.calls.some(([url]) => url.endsWith('/stop-launch'))).toBe(false);
    expect(runTask).not.toHaveBeenCalled();
    expect(editMessage.mock.calls.some(call => String(call[3]).includes('Задача продолжает работать'))).toBe(false);
  });

  it('unconfirmed stop may launch stop-new input as a separate task', async () => {
    const { env, fetch } = environment(true);
    fetch.mockImplementation(async url => url.endsWith('/held')
      ? Response.json({ items: [{}] })
      : url.endsWith('/stop-launch') ? Response.json({ launching: true, count: 1 })
        : Response.json({ owned: true }));
    await handleCallbackQuery(callback('intake_stopyes|new'), env);
    const launch = fetch.mock.calls.find(([url]) => url.endsWith('/stop-launch'));
    expect(launch).toBeDefined();
    expect(JSON.parse(launch[1].body)).toMatchObject({ mode: 'new', callbackData: 'intake_stopyes|new' });
    expect(editMessage.mock.calls.some(call => String(call[3]).includes('старая может продолжить работу'))).toBe(true);
    expect(editMessage.mock.calls.some(call => String(call[3]).includes('Задача остановлена'))).toBe(false);
  });

  it('stop prompt registers exact returned confirmation ID against the original source', async () => {
    const { env, fetch } = environment(true);
    sendMessageWithKeyboard.mockResolvedValueOnce({ ok: true, result: { message_id: 84 } });
    fetch.mockImplementation(async url => Response.json(url.endsWith('/held') ? { items: [{}] } : { owned: true }));
    await handleCallbackQuery(callback('intake_stopsupp'), env);
    const registration = fetch.mock.calls.find(([url]) => url.endsWith('/callback-confirmation'));
    expect(JSON.parse(registration[1].body)).toEqual({ sourceMessageId: 42, messageId: 84,
      callbackData: 'intake_stopsupp', username: session.username });
    expect(stopChat).not.toHaveBeenCalled();
  });

  it('failed confirmation registration removes only its new keyboard and performs no stop', async () => {
    const { env, fetch } = environment(true);
    sendMessageWithKeyboard.mockResolvedValueOnce({ ok: true, result: { message_id: 84 } });
    fetch.mockImplementation(async url => url.endsWith('/callback-confirmation')
      ? new Response('{}', { status: 409 }) : Response.json(url.endsWith('/held') ? { items: [{}] } : { owned: true }));
    await handleCallbackQuery(callback('intake_stopnew'), env);
    expect(editMessage).toHaveBeenCalledWith('fixture-token', 7, 84,
      '⚠️ Подтверждение кнопки не сохранено — остановка не выполнялась.',
      expect.objectContaining({ reply_markup: { inline_keyboard: [] } }));
    expect(stopChat).not.toHaveBeenCalled();
  });
});

function actualDo() {
  const entries = new Map();
  const storage = {
    get: async key => entries.get(key),
    put: async (key, value) => { entries.set(key, value); },
    delete: async key => entries.delete(key),
    list: async ({ prefix = '' } = {}) => new Map([...entries].filter(([key]) => key.startsWith(prefix))),
    getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {},
    transaction: async operation => operation(storage),
  };
  const env = { EXECUTION_BACKEND: 'control-plane', BOT_TOKEN: 'fixture-token', TG_SANDBOX_BOT_TOKEN: 'fixture-token', SESSIONS: {} };
  const object = new IntakeBuffer({ storage }, env);
  env.INTAKE = { idFromName: vi.fn(name => name), get: vi.fn(() => ({ fetch: (url, init) => object.fetch(new Request(url, init)) })) };
  return { object, entries, env };
}

describe('actual IntakeBuffer callback composition (ownership endpoint is not mocked)', () => {
  function seed(entries, queued = false) {
    entries.set('collectorMsgId', 42);
    entries.set('buf', [{ text: 'fixture task', msg: { chat: { id: 7 }, message_id: 10, text: 'fixture task' } }]);
    if (queued) {
      entries.set('launchQueued', true);
      entries.set('launchAfterRelease', true);
    }
  }

  it('current collector ownership succeeds through the real DO endpoint', async () => {
    const { entries, env } = actualDo();
    seed(entries);
    expect(await controlPlaneCallbackOwned(callback('intake_run'), env, session)).toBe(true);
  });

  it('current cancel button reaches actual DO mutation and preserves input', async () => {
    const { entries, env } = actualDo();
    seed(entries, true);
    await handleCallbackQuery(callback('intake_cancel'), env);
    expect(entries.has('launchQueued')).toBe(false);
    expect(entries.has('launchAfterRelease')).toBe(false);
    expect(entries.get('buf')).toHaveLength(1);
    expect(runTask).not.toHaveBeenCalled();
  });

  for (const endpoint of ['flush', 'cancel']) it(`real DO ${endpoint} refuses changed collector after ownership precheck`, async () => {
    const { object, entries, env } = actualDo();
    seed(entries, endpoint === 'cancel');
    const data = endpoint === 'flush' ? 'intake_run' : 'intake_cancel';
    expect(await controlPlaneCallbackOwned(callback(data), env, session)).toBe(true);
    entries.set('collectorMsgId', 99);
    const before = [...entries];
    const response = await object.fetch(new Request(`https://intake/${endpoint}`, { method: 'POST',
      body: JSON.stringify({ sourceMessageId: 42, callbackData: data, username: session.username, parallel: false }) }));
    expect(response.status).toBe(409);
    expect([...entries]).toEqual(before);
  });

  it('stale collector never changes a newly queued batch through real DO', async () => {
    const { entries, env } = actualDo();
    seed(entries, true);
    entries.set('collectorMsgId', 99);
    await handleCallbackQuery(callback('intake_cancel'), env);
    expect(entries.get('launchQueued')).toBe(true);
    expect(entries.get('buf')).toHaveLength(1);
    expect(stopChat).not.toHaveBeenCalled();
  });
});
