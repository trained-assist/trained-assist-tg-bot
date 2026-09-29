import { it, expect, vi, afterEach } from 'vitest';
import { checkCompleteness } from '../src/lib/agent-client.js';
afterEach(()=>vi.unstubAllGlobals());

// Changed with #248 (was: every failure → `insufficient`). A judge that did not
// answer is not a verdict: collapsing a timeout/5xx/bad body into «недостаточно
// контекста» made a degraded judge indistinguishable from a real one and killed
// the batch's auto-launch timer silently (live chat -1003814002203, 2026-09-29).
// Requirement now: failures surface as `error` (the intake DO retries them), while
// a genuine `insufficient` from the judge still wins unchanged.
const ERROR = { level: 'error', complete: false, delayMs: null, announce: null, retryable: true };

it.each(['network', 'http', 'json', 'unknown'])('gate %s failure reports error, not a hold verdict',async kind=>{
  vi.stubGlobal('fetch',vi.fn(async()=>{
    if(kind==='network') throw Error('offline');
    return {ok:kind!=='http',json:async()=>{if(kind==='json')throw Error('bad JSON');return {level:'unknown'};}};
  }));
  expect(await checkCompleteness({AGENT_URL:'https://agent',AGENT_SECRET:'test'},{text:'task'})).toEqual(ERROR);
});

it('a real insufficient verdict is passed through unchanged (not an error)', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, json: async () => ({ level: 'insufficient', complete: false, delayMs: null, announce: 'x' }),
  })));
  const r = await checkCompleteness({ AGENT_URL: 'https://agent', AGENT_SECRET: 't' }, { text: 'task' });
  expect(r.level).toBe('insufficient');
  expect(r.retryable).toBeUndefined();
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
