import { it, expect, vi, afterEach } from 'vitest';
import { checkCompleteness } from '../src/lib/agent-client.js';
afterEach(()=>vi.unstubAllGlobals());

const HOLD = { level: 'insufficient', complete: false, delayMs: null, announce: null };

it.each(['network', 'http', 'json', 'unknown'])('gate %s failure holds instead of launching',async kind=>{
  vi.stubGlobal('fetch',vi.fn(async()=>{
    if(kind==='network') throw Error('offline');
    return {ok:kind!=='http',json:async()=>{if(kind==='json')throw Error('bad JSON');return {level:'unknown'};}};
  }));
  expect(await checkCompleteness({AGENT_URL:'https://agent',AGENT_SECRET:'test'},{text:'task'})).toEqual(HOLD);
});

it('forwards the chat identity so the judge can see the previous agent answer', async () => {
  let sent;
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    sent = JSON.parse(init.body);
    return { ok: true, json: async () => ({ level: 'continue', complete: true, delayMs: 30000, announce: 'x' }) };
  }));
  const r = await checkCompleteness({ AGENT_URL: 'https://agent', AGENT_SECRET: 't' },
    { text: 'давай дальше', username: 'alice', chatId: 42, threadId: 7 });
  expect(sent).toEqual({ text: 'давай дальше', username: 'alice', chatId: 42, threadId: 7 });
  expect(r.level).toBe('continue');
  expect(r.delayMs).toBe(30000);
});
