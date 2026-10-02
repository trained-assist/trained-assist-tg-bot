import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// SS-05 (#325) — a user stop must cancel work the gateway already put into
// delivery (RunOutbox + recovery queue), not only the running process. These
// tests exercise the REAL Durable Object classes and the real stopChat entry
// point; only the agent /tasks/stop call is faked.

vi.mock('../src/lib/agent-client.js', () => ({ stopTask: vi.fn(async () => ({ killed: 0 })) }));

import { RunOutbox } from '../src/run-outbox.js';
import { RetryQueue } from '../src/retry-queue.js';
import { cancelRetries } from '../src/lib/kv.js';
import { stopChat, stopReplyText } from '../src/lib/stop-chat.js';
import { stopTask } from '../src/lib/agent-client.js';

function outboxFixture() {
  const data = new Map(); let alarm = null;
  const storage = {
    get: async k => data.get(k), put: async (k, v) => data.set(k, structuredClone(v)), delete: async k => data.delete(k),
    list: async ({ prefix, limit }) => new Map([...data].filter(([k]) => k.startsWith(prefix)).slice(0, limit)),
    setAlarm: async v => { alarm = v; }, deleteAlarm: async () => { alarm = null; },
    transaction: async fn => fn(storage),
  };
  const state = { storage, blockConcurrencyWhile: fn => fn() };
  const env = { AGENT_URL: 'https://agent', AGENT_SECRET: 'secret', BOT_TOKEN: 'test' };
  return { data, storage, state, env, outbox: new RunOutbox(state, env), alarm: () => alarm };
}
const enqueue = (box, id, extra = {}) => box.fetch(new Request('https://outbox', {
  method: 'POST', body: JSON.stringify({ agentUrl: 'https://agent', body: { requestId: id, userId: 1, username: 'u', task: 'work', ...extra } }),
}));
const cancel = (box, body) => box.fetch(new Request('https://outbox/cancel', { method: 'POST', body: JSON.stringify(body) }));

function retryFixture() {
  const map = new Map();
  const storage = {
    put: async (k, v) => map.set(k, structuredClone(v)), get: async k => structuredClone(map.get(k)),
    delete: async k => map.delete(k), list: async ({ prefix }) => new Map([...map].filter(([k]) => k.startsWith(prefix))),
  };
  const env = { BOT_TOKEN: 't', SESSIONS: {} };
  return { map, queue: new RetryQueue({ storage }, env) };
}
const recover = (q, chatId, opts = {}) => q.fetch(new Request('https://recovery/enqueue', {
  method: 'POST', body: JSON.stringify({ chatId, text: 'x', opts }),
}));
const recoverCancel = (q, body) => q.fetch(new Request('https://recovery/cancel', { method: 'POST', body: JSON.stringify(body) }));

function fakeKv() {
  const store = new Map();
  return {
    put: async (k, v, o = {}) => store.set(k, { value: v, metadata: o.metadata }),
    get: async k => store.get(k)?.value ?? null,
    delete: async k => store.delete(k),
    list: async ({ prefix }) => ({ keys: [...store.keys()].filter(n => n.startsWith(prefix)).map(name => ({ name })) }),
    _store: store,
  };
}

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => { stopTask.mockClear(); stopTask.mockResolvedValue({ killed: 0 }); });

describe('stop cancels the durable outbox (#325)', () => {
  it('removes only the stopped chat’s job, its chunks, and tombstones the requestId', async () => {
    const f = outboxFixture();
    await enqueue(f.outbox, 'a', { userId: 1 });
    await enqueue(f.outbox, 'b', { userId: 2 });
    const res = await cancel(f.outbox, { chatId: 1 });
    expect((await res.json()).cancelled).toBe(1);
    expect(f.data.has('job:a')).toBe(false);
    expect(f.data.has('a:0')).toBe(false);
    expect(f.data.has('cancelled:a')).toBe(true);
    expect(f.data.has('job:b')).toBe(true);
  });

  it('never delivers a cancelled job and blocks re-enqueue of the same requestId', async () => {
    const f = outboxFixture();
    await enqueue(f.outbox, 'a', { userId: 1 });
    await cancel(f.outbox, { chatId: 1 });
    const seen = [];
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      if (String(url).endsWith('/maintenance')) return Response.json({ durableIngress: 1 });
      if (String(url).includes('telegram')) return Response.json({ ok: true });
      seen.push(JSON.parse(opts.body).requestId);
      return Response.json({ taskId: 'a', requestId: 'a', durable: true });
    }));
    await f.outbox.alarm();
    expect(seen).toEqual([]);
    await enqueue(f.outbox, 'a', { userId: 1 });
    expect(f.data.has('job:a')).toBe(false);
  });

  it('is thread-scoped when a forum topic is given', async () => {
    const f = outboxFixture();
    await enqueue(f.outbox, 't1', { userId: 1, threadId: 10 });
    await enqueue(f.outbox, 't2', { userId: 1, threadId: 20 });
    const res = await cancel(f.outbox, { chatId: 1, threadId: 10 });
    expect((await res.json()).cancelled).toBe(1);
    expect(f.data.has('job:t1')).toBe(false);
    expect(f.data.has('job:t2')).toBe(true);
  });
});

describe('stop cancels the recovery queue (#325)', () => {
  it('drops queued recovery for the chat only', async () => {
    const { map, queue } = retryFixture();
    await recover(queue, 42);
    await recover(queue, 99);
    const res = await recoverCancel(queue, { chatId: 42 });
    expect((await res.json()).cancelled).toBe(1);
    expect([...map.keys()].filter(k => k.startsWith('retry:42:'))).toHaveLength(0);
    expect([...map.keys()].filter(k => k.startsWith('retry:99:'))).toHaveLength(1);
  });

  it('honours threadId when cancelling recovery entries', async () => {
    const { map, queue } = retryFixture();
    await recover(queue, 42, { threadId: 10 });
    await recover(queue, 42, { threadId: 20 });
    const res = await recoverCancel(queue, { chatId: 42, threadId: 10 });
    expect((await res.json()).cancelled).toBe(1);
    expect([...map.keys()].filter(k => k.startsWith('retry:42:'))).toHaveLength(1);
  });

  it('cancelRetries on shared KV deletes only matching chat entries', async () => {
    const kv = fakeKv();
    await kv.put('retry:42:a', JSON.stringify({ chatId: 42, opts: { threadId: 10 } }));
    await kv.put('retry:42:b', JSON.stringify({ chatId: 42, opts: { threadId: 20 } }));
    await kv.put('retry:99:c', JSON.stringify({ chatId: 99, opts: {} }));
    expect(await cancelRetries(kv, 42, 10)).toBe(1);
    expect(kv._store.has('retry:42:a')).toBe(false);
    expect(kv._store.has('retry:42:b')).toBe(true);
    expect(kv._store.has('retry:99:c')).toBe(true);
  });
});

describe('stopChat wiring (#325)', () => {
  it('cancels outbox + recovery, then kills the run, and reports honestly', async () => {
    const f = outboxFixture();
    await enqueue(f.outbox, 'job1', { userId: 42, username: 'owner' });
    const { map, queue } = retryFixture();
    await recover(queue, 42);
    const env = {
      RUN_OUTBOX: { idFromName: n => n, get: () => ({ fetch: (url, opts) => f.outbox.fetch(new Request(url, opts)) }) },
      RETRY_QUEUE: { idFromName: n => n, get: () => ({ fetch: (url, opts) => queue.fetch(new Request(url, opts)) }) },
      SESSIONS: fakeKv(),
      RECOVERY_IMPORT_LEGACY: 'on',
      AGENT_URL: 'https://agent', AGENT_SECRET: 's',
    };
    const res = await stopChat(env, { username: 'owner', chatId: 42 });
    expect(res.cancelled).toBe(2); // 1 outbox + 1 recovery
    expect(f.data.has('job:job1')).toBe(false);
    expect([...map.keys()].filter(k => k.startsWith('retry:42:'))).toHaveLength(0);
    expect(stopTask).toHaveBeenCalledTimes(1);
    const text = stopReplyText(res, { button: true });
    expect(text).toContain('очередь не запустится');
    expect(text).not.toContain('автоматически');
  });

  it('a stop with nothing queued keeps the old wording', () => {
    expect(stopReplyText({ killed: 0, held: 0, cancelled: 0, hadIntent: false, error: null }, { button: true }))
      .toContain('Нет активной задачи');
  });
});
