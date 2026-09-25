import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { IntakeBuffer } from '../src/intake-buffer.js';
import { runTask } from '../src/lib/agent-client.js';
import { handleCallbackQuery } from '../src/handlers/callbacks.js';
import { assembleInput } from '../src/input-assembly.js';

const send = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/telegram.js', () => ({
  answerCallbackQuery: vi.fn(), sendMessage: send, sendMessageWithKeyboard: send, sendDocument: send,
  editMessage: send, editMessageReplyMarkup: send, deleteMessage: send,
}));
vi.mock('../src/lib/kv.js', async original => ({ ...(await original()), getSession: vi.fn(async () => ({ username: 'alice' })) }));
function world() {
  const data = new Map(); let alarm = null;
  const storage = { get: async k => structuredClone(data.get(k)),
    put: async (k,v) => data.set(k, structuredClone(v)), delete: async k => data.delete(k),
    list: async ({prefix = ''} = {}) => new Map([...data].filter(([k]) => k.startsWith(prefix))),
    getAlarm: async () => alarm, setAlarm: async t => { alarm = t; }, deleteAlarm: async () => { alarm = null; },
    transaction: async f => f(storage),
  };
  const env = { BOT_TOKEN: 't', AGENT_URL: 'https://agent.test', AGENT_SECRET: 'test' };
  const io = new IntakeBuffer({ storage }, env);
  const keys = [];
  env.INTAKE = { idFromName: key => { keys.push(key); return key; }, get: () => ({ fetch: (url, opts) => io.fetch(new Request(url, opts)) }) };
  return { env, io, storage, keys, data };
}
const item = (id, text, extra = {}) => ({ text, msg: { chat: { id: 42 }, message_id: id, text, ...extra } });
const read = (io, mid = 99, username = 'alice') => io.fetch(new Request(`https://intake/input?messageId=${mid}&username=${username}`));
const append = (io, i) => io.fetch(new Request('https://intake/append', { method: 'POST', body: JSON.stringify(i) }));
beforeEach(() => { vi.clearAllMocks(); send.mockResolvedValue({ ok: true, result: { message_id: 99 } });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ durable: true, taskId: 't' }))); });
afterEach(() => vi.unstubAllGlobals());

describe('immutable actual input', () => {
  it('stores exactly the request sent to the agent, keeps source order/forwards/entities, and survives restart', async () => {
    const w = world();
    const items = [item(1, 'https://example.test', { entities: [{ type: 'url', offset: 0, length: 20 }], forward_origin: { type: 'hidden_user', sender_user_name: 'Sender' } }),
      item(2, '', { voice: { file_id: 'voice-1' }, transcript: 'мой голос', fileRef: { id: 'f', storage: 'r2', name: 'voice.ogg' } })];
    const assembled = assembleInput(items);
    await runTask(w.env, { userId: 42, username: 'alice', requestId: 'request-1', initialMsgId: 99, sessionId: 's1',
      task: assembled.task, inputItems: items, threadId: 7 });
    const wire = JSON.parse(fetch.mock.calls.find(([url]) => String(url).endsWith('/run'))[1].body);
    const snapshot = await (await read(w.io)).json();
    expect(snapshot.body).toEqual(wire);
    expect(snapshot.items).toEqual(items);
    expect(w.keys).toContain('42:7');
    const restarted = new IntakeBuffer({ storage: w.storage }, w.env);
    expect(await (await read(restarted)).json()).toEqual(snapshot);
    await append(w.io, item(3, 'добавление'));
    expect(await (await read(w.io)).json()).toEqual(snapshot);
  });
  it('retries the immutable wire body, even if callers changed their text or timestamp', async () => {
    const { io, env } = world();
    const args = { userId: 42, username: 'alice', requestId: 'same-request', initialMsgId: 99, task: 'original', inputItems: [item(1,'original')] };
    await runTask(env, args);
    await runTask(env, { ...args, task: 'changed', initialMsgId: 100, inputItems: [item(2,'changed')] });
    const bodies = fetch.mock.calls.filter(([url]) => String(url).endsWith('/run')).map(([,opts]) => JSON.parse(opts.body));
    expect(bodies[1]).toEqual(bodies[0]);
    expect((await (await read(io, 100)).json()).body.task).toBe('original');
  });
  it('blocks another logged-in profile from reading or replacing the snapshot', async () => {
    const { io, env } = world();
    await runTask(env, { userId: 42, username: 'alice', requestId: 'r1', initialMsgId: 99, task: 'private', inputItems: [item(1,'private')] });
    expect((await read(io, 99, 'bob')).status).toBe(403);
    await expect(runTask(env, { userId: 42, username: 'bob', requestId: 'r1', initialMsgId: 99, task: 'overwrite', inputItems: [] })).rejects.toThrow('403');
    expect((await read(io, 123)).status).toBe(404);
  });
  it('chunks long Unicode input below the DO per-value limit, without truncation', async () => {
    const { io, env, data } = world();
    const task = '📷 Привет '.repeat(20000);
    await runTask(env, { userId: 42, username: 'alice', requestId: 'large', initialMsgId: 99, task, inputItems: [item(1, task)] });
    expect((await (await read(io)).json()).body.task).toBe(task);
    for (const [key, value] of data) if (key.startsWith('input:large:')) expect(new TextEncoder().encode(value).length).toBeLessThan(128 * 1024);
  });
  it('draft uses the launch assembler and exposes pending media in original order', async () => {
    const { io, storage } = world();
    const items = [item(3,'last'), { ...item(2,'', {photo:[{file_id:'p'}], caption:'image'}), mediaPending: true }, item(1,'first')];
    await storage.put('buf', items);
    const response = await io.fetch(new Request('https://intake/input?draft=true'));
    const draft = await response.json();
    expect(draft.items.map(i => i.msg.message_id)).toEqual([1,2,3]);
    expect(draft.task).toBe(assembleInput([items[2],items[1],items[0]]).task);
    expect(draft.pending).toBe(true);
  });
  it('a delayed Telegram receipt cannot create duplicate collectors during overlapping alarm requests', async () => {
    const { io, storage } = world();
    let release;
    send.mockImplementationOnce(() => new Promise(r => { release = () => r({ ok:true, result:{message_id:99} }); }));
    await Promise.all([3,1,2].map(id => append(io, item(id, `part-${id}`))));
    await storage.put('receiptDue', Date.now()-1);
    const first = io.alarm();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await append(io, item(4,'last'));
    await storage.put('receiptDue', Date.now()-1);
    const second = io.alarm();
    release(); await Promise.all([first,second]);
    // One send, then an edit of its id (4th argument is text for edits).
    expect(send.mock.calls.filter(c => Array.isArray(c[3]))).toHaveLength(1);
    expect(send.mock.calls.at(-1)[3]).toContain('4 сообщений');
  });
});

it('inspection callback sends the full private snapshot to the original topic, journal links the saved session', async () => {
  const { env, io } = world();
  await runTask(env, { userId: 42, username: 'alice', requestId: 'inspect', initialMsgId: 99,
    task: 'секретный запрос', sessionId: 'saved-session', inputItems: [item(1,'секретный запрос')] });
  send.mockClear();
  await handleCallbackQuery({ id: 'cb', data: 'input_run|99', message: { message_id: 200, chat:{id:42}, message_thread_id:7 } }, env);
  expect(send).toHaveBeenCalledWith('t', 42, 'input-snapshot.txt', expect.stringContaining('секретный запрос'), expect.any(String), 7);
  send.mockClear();
  await handleCallbackQuery({ id: 'cb2', data: 'input_journal|99', message: { message_id: 200, chat:{id:42} } }, env);
  expect(send.mock.calls[0][2]).toContain('#/session/saved-session');
  expect((await read(io)).status).toBe(200);
});
