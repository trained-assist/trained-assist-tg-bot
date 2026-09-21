import { describe, it, expect, vi, beforeEach } from 'vitest';
const mock = vi.hoisted(() => ({ run: vi.fn(), session: vi.fn(), send: vi.fn(), classify: vi.fn(), set: vi.fn() }));
vi.mock('../src/lib/agent-client.js', () => ({ runTask: mock.run, classifyAgentError: mock.classify,
  getSessions: vi.fn(), classifyMessage: vi.fn(), getProjectDecision: vi.fn() }));
vi.mock('../src/lib/telegram.js', () => ({ sendMessage: mock.send, sendMessageWithKeyboard: vi.fn(), sendDocument: vi.fn() }));
vi.mock('../src/handlers/commands.js', () => ({ renderSessionList: vi.fn(), escHtml: x => x, timeAgo: vi.fn() }));
vi.mock('../src/lib/kv.js', async importOriginal => ({ ...(await importOriginal()), getSession: mock.session, setSession: mock.set }));
import { RetryQueue } from '../src/retry-queue.js';
import { handleMessage } from '../src/handlers/message.js';

function world() {
  const map = new Map();
  const storage = { put: async (k,v) => map.set(k, structuredClone(v)), get: async k => structuredClone(map.get(k)),
    delete: async k => map.delete(k), list: async ({prefix}) => new Map([...map].filter(([k]) => k.startsWith(prefix))) };
  const env = { BOT_TOKEN: 'test', SESSIONS: {} };
  let queue = new RetryQueue({ storage }, env);
  env.RETRY_QUEUE = { idFromName: x => x, get: () => ({ fetch: (url, opts) => queue.fetch(new Request(url, opts)) }) };
  const drain = () => queue.fetch(new Request('https://recovery/drain', { method: 'POST' }));
  const due = () => { for (const [k,v] of map) if(k.startsWith('retry:')) { v.metadata.dueAt = 0; const e=JSON.parse(v.value); e.dueAt=0; v.value=JSON.stringify(e); } };
  return { env, map, drain, due, restart: () => { queue = new RetryQueue({ storage }, env); },
    enqueue: (opts={}) => queue.fetch(new Request('https://recovery/enqueue', { method:'POST', body:JSON.stringify({chatId:42,text:'работа',opts:{resolvedRoute:{type:'run',sessionId:'s-1'}, retryUsername:'u',...opts}}) })) };
}
beforeEach(() => {
  vi.resetAllMocks();
  mock.session.mockResolvedValue({ username:'u', lastSessionId:'s-1',lastMessageAt:Date.now() });
  mock.send.mockResolvedValue({ok:true,result:{message_id:10}});
  mock.run.mockResolvedValue({}); mock.classify.mockResolvedValue('down');
});
describe('durable recovery, real coordinator + handler + storage', () => {
  it('overlapping cron calls dispatch exactly once and save receipt', async () => {
    const w=world(); await w.enqueue(); w.due();
    await Promise.all([w.drain(),w.drain()]);
    expect(mock.run).toHaveBeenCalledTimes(1);
    expect([...w.map.keys()].filter(k=>k.startsWith('retry:'))).toHaveLength(0);
    expect([...w.map.values()].some(v=>JSON.parse(v.value).outcome==='accepted')).toBe(true);
  });
  it('two failed attempts remain bounded across object restarts and preserve refs/route', async () => {
    const w=world(); mock.run.mockRejectedValue(new Error('HTTP 503'));
    await w.enqueue({requestId:'req1',fileRefs:['file1'],mode:'deep'}); w.due(); await w.drain();
    expect(mock.run).toHaveBeenCalledTimes(1); w.restart(); w.due(); await w.drain();
    expect(mock.run).toHaveBeenCalledTimes(2); w.due(); await w.drain();
    expect(mock.run).toHaveBeenCalledTimes(2);
    expect(mock.run.mock.calls[1][1]).toMatchObject({sessionId:'s-1',requestId:'req1',fileRefs:['file1'],mode:'deep'});
    expect(mock.send.mock.calls.some(c=>c[2].includes('2/2 не удалась'))).toBe(true);
  });
  it('Telegram ok:false retries ONLY terminal notification after restart, never /run', async () => {
    const w=world(); await w.enqueue(); w.due();
    mock.send.mockImplementation(async (_t,_c,text) => text.startsWith('✅') ? {ok:false,description:'rate limited'} : {ok:true});
    await w.drain(); expect(mock.run).toHaveBeenCalledTimes(1);
    expect([...w.map.values()].some(v=>JSON.parse(v.value).terminal?.outcome==='accepted')).toBe(true);
    w.restart(); mock.send.mockResolvedValue({ok:true}); w.due(); await w.drain();
    expect(mock.run).toHaveBeenCalledTimes(1);
    expect(mock.send.mock.calls.at(-1)[2]).toContain('агент принял');
  });
  it('failure saving session after ACK cannot queue the already accepted work', async () => {
    const w=world(); await w.enqueue(); w.due(); mock.set.mockRejectedValue(new Error('KV unavailable'));
    await w.drain(); w.due(); await w.drain(); expect(mock.run).toHaveBeenCalledTimes(1);
    expect(mock.send.mock.calls.at(-1)[2]).toContain('агент принял');
  });
  it('durable intake transfers ownership on agent downtime; preserves exact request ID', async () => {
    const w=world(); mock.run.mockRejectedValueOnce(new Error('HTTP 503'));
    await handleMessage({chat:{id:42},text:'работа'},w.env,{durableInput:true,requestId:'original',intakeRoute:{type:'run',sessionId:'s-1'}});
    expect([...w.map.keys()].filter(k=>k.startsWith('retry:'))).toHaveLength(1);
    w.due(); await w.drain();
    expect(mock.run).toHaveBeenCalledTimes(2);
    expect(mock.run.mock.calls[1][1].requestId).toBe('original');
  });
  it('crash after dispatch intent is visible and does not blindly duplicate /run', async () => {
    const w=world(); await w.enqueue();
    for(const row of w.map.values()) { const e=JSON.parse(row.value);e.startedAt=1;row.value=JSON.stringify(e); }
    w.restart();w.due();await w.drain();
    expect(mock.run).not.toHaveBeenCalled();expect(mock.send.mock.calls.at(-1)[2]).toContain('без подтверждённого результата');
  });
  it('profile switch cancels recovery visibly without leaking work into the other profile', async () => {
    const w=world(); await w.enqueue();mock.session.mockResolvedValue({username:'other'});w.due();await w.drain();
    expect(mock.run).not.toHaveBeenCalled();expect(mock.send.mock.calls.at(-1)[2]).toContain('Восстановление отменено');
  });

});
