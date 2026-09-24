import { it, expect, vi, afterEach } from 'vitest';
import { checkCompleteness } from '../src/lib/agent-client.js';
afterEach(()=>vi.unstubAllGlobals());
it.each(['network', 'http', 'json', 'unknown'])('gate %s failure holds instead of launching',async kind=>{
  vi.stubGlobal('fetch',vi.fn(async()=>{
    if(kind==='network') throw Error('offline');
    return {ok:kind!=='http',json:async()=>{if(kind==='json')throw Error('bad JSON');return {level:'unknown'};}};
  }));
  expect(await checkCompleteness({AGENT_URL:'https://agent',AGENT_SECRET:'test'},{text:'task'})).toEqual({level:'insufficient',complete:false});
});
