import { describe, it, expect, vi, afterEach } from 'vitest';
import { RunOutbox } from '../src/run-outbox.js';

// Prod 2026-10-04, chat -5111318625: the window stayed busy for 33 minutes with
// six messages inside and no run. Cause: the dispatch had gone through the outbox,
// so `busyViaOutbox` disabled the self-heal poll, and nothing ever released it —
// the job was undeliverable (the agent had been torn down), so it retried forever
// and BUSY_MAX_MS (45 min) was the only backstop.
//
// The queue owner now releases the hold once it has told the user the job is stuck.
// The payload is NOT dropped: it is still delivered when the agent returns.
function fixture() {
  const data = new Map(); let alarm = null;
  const storage = {
    get: async k => data.get(k), put: async (k, v) => data.set(k, structuredClone(v)), delete: async k => data.delete(k),
    list: async ({ prefix, limit }) => new Map([...data].filter(([k]) => k.startsWith(prefix)).slice(0, limit)),
    setAlarm: async v => { alarm = v; }, deleteAlarm: async () => { alarm = null; },
    transaction: async fn => fn(storage),
  };
  const state = { storage, blockConcurrencyWhile: fn => fn() };
  const env = { AGENT_URL: 'https://agent', AGENT_SECRET: 'secret', BOT_TOKEN: 'test', INTAKE: null };
  const released = [];
  // Захватываем разговор с IntakeBuffer: холд отпускается именно этим вызовом.
  env.INTAKE = {
    idFromName: n => n,
    get: () => ({ fetch: async (url, opts) => { released.push(JSON.parse(opts.body)); return new Response('{}'); } }),
  };
  return { data, storage, state, env, outbox: new RunOutbox(state, env), alarm: () => alarm, released };
}

const enqueue = (box, id, extra = {}) =>
  box.fetch(new Request('https://outbox', {
    method: 'POST',
    body: JSON.stringify({ agentUrl: 'https://agent', body: { requestId: id, userId: 1, username: 'u', task: 'work', ...extra } }),
  }));

const realStubGlobal = vi.stubGlobal.bind(vi);
function mockFetch(fn) {
  realStubGlobal('fetch', vi.fn((url, opts) =>
    String(url).endsWith('/maintenance') ? Promise.resolve(Response.json({ durableIngress: 1 })) : fn(url, opts)));
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('outbox отпускает busy-холд, который сам же и повесил', () => {
  it('короткий перебой агента НЕ трогает холд — рестарт это не поломка', async () => {
    const f = fixture(); await enqueue(f.outbox, 'a');
    let now = 1000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    mockFetch(async url => { if (url.includes('telegram')) return Response.json({ ok: true }); throw Error('restarting'); });

    await f.outbox.alarm();
    now += 15_000; await f.outbox.alarm();       // 15 с — тишина, холд на месте
    expect(f.released).toEqual([]);
    expect(f.data.get('job:a').holdReleased).toBeFalsy();
  });

  it('долгий простой агента отпускает холд РОВНО ОДИН раз и говорит, что чат свободен', async () => {
    const f = fixture(); await enqueue(f.outbox, 'a');
    let now = 1000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const tg = [];
    mockFetch(async (url, opts) => {
      if (url.includes('telegram')) { tg.push(JSON.parse(opts.body).text); return Response.json({ ok: true }); }
      throw Error('agent down');
    });

    await f.outbox.alarm();                       // первая неудача
    now += 40_000; await f.outbox.alarm();        // простой перевалил порог → notify + release
    expect(f.released).toHaveLength(1);
    expect(f.released[0].requestId).toBe('a');
    expect(tg.some(t => t.includes('Пока можешь писать в чат'))).toBe(true);

    now += 20_000; await f.outbox.alarm();        // дальше — тишина, холд не дёргаем
    now += 20_000; await f.outbox.alarm();
    expect(f.released).toHaveLength(1);
  });

  it('задача НЕ теряется: после отпускания холда очередь доставляет её как обычно', async () => {
    const f = fixture(); await enqueue(f.outbox, 'a');
    let now = 1000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    mockFetch(async url => { if (url.includes('telegram')) return Response.json({ ok: true }); throw Error('agent down'); });
    await f.outbox.alarm(); now += 40_000; await f.outbox.alarm();
    expect(f.released).toHaveLength(1);
    expect(f.data.has('job:a')).toBe(true);      // платящий в очередь остался в очереди

    // Агент вернулся — та же задача уходит и подтверждается.
    const sent = [];
    mockFetch(async (_url, opts) => {
      if (String(opts?.body).includes('requestId')) sent.push(JSON.parse(opts.body).requestId);
      return Response.json({ taskId: 't-a', requestId: 'a', durable: true });
    });
    now += 20_000; await f.outbox.alarm();
    expect(sent).toContain('a');
    expect(f.data.has('job:a')).toBe(false);
    expect(f.data.has('done:a')).toBe(true);
  });
});
