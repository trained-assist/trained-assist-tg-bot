import { describe, it, expect, vi, afterEach } from 'vitest';
import { RunOutbox } from '../src/run-outbox.js';
function fixture() {
  const data = new Map(); let alarm = null;
  const storage = {
    get: async k => data.get(k), put: async (k,v) => data.set(k,structuredClone(v)), delete: async k => data.delete(k),
    list: async ({prefix,limit}) => new Map([...data].filter(([k])=>k.startsWith(prefix)).slice(0,limit)),
    setAlarm: async v => { alarm=v; }, deleteAlarm: async () => { alarm=null; },
    transaction: async fn => fn(storage),
  };
  const state = { storage, blockConcurrencyWhile: fn => fn() };
  const env = { AGENT_URL: 'https://agent', AGENT_SECRET: 'secret', BOT_TOKEN: 'test' };
  return { data, storage, state, env, outbox: new RunOutbox(state,env), alarm: ()=>alarm };
}
const enqueue = (box,id,extra={}) => box.fetch(new Request('https://outbox', { method:'POST', body:JSON.stringify({agentUrl:'https://agent',body:{requestId:id,userId:1,username:'u',task:'work',...extra}}) }));
afterEach(()=>vi.unstubAllGlobals());
describe('durable restart outbox',()=>{
  it('persists a large attachment before ACK; reconstruction and retry retain the exact payload',async()=>{
    const f=fixture(); const file='abc'.repeat(100000); const sent=[];
    expect((await enqueue(f.outbox,'one',{fileBase64:file,mode:'deep',projectId:'p'})).status).toBe(202);
    expect(f.alarm()).not.toBe(null); expect(f.data.has('one:8')).toBe(true);
    vi.stubGlobal('fetch',vi.fn(async (url,opts)=>{
      if(url.includes('telegram')) return Response.json({ok:true});
      sent.push(JSON.parse(opts.body)); throw Error('server restarting');
    }));
    await f.outbox.alarm(); expect(f.data.has('job:one')).toBe(true);
    const afterCrash=new RunOutbox(f.state,f.env);
    vi.stubGlobal('fetch',vi.fn(async(_url,opts)=>{ sent.push(JSON.parse(opts.body));return Response.json({taskId:'u-one', requestId:'one', durable:true}); }));
    await afterCrash.alarm();
    expect(sent[1]).toEqual(sent[0]); expect(sent[1].fileBase64).toBe(file);
    expect(f.data.has('job:one')).toBe(false); expect(f.data.has('one:0')).toBe(false); expect(f.data.has('done:one')).toBe(true); expect(f.alarm()).toBe(null);
  });
  it('lost ACK repeats the same id; a later request cannot overtake',async()=>{
    const f=fixture(); await enqueue(f.outbox,'a'); await enqueue(f.outbox,'b'); const seen=[];
    vi.stubGlobal('fetch',vi.fn(async(url,opts)=>{
      if(url.includes('telegram'))return Response.json({ok:true});
      seen.push(JSON.parse(opts.body).requestId); throw Error('ACK lost');
    }));
    await f.outbox.alarm(); expect(seen).toEqual(['a']);
    vi.stubGlobal('fetch',vi.fn(async(_url,opts)=>{seen.push(JSON.parse(opts.body).requestId);const id=JSON.parse(opts.body).requestId; return Response.json({taskId:id,requestId:id,durable:true});}));
    await f.outbox.alarm(); await f.outbox.alarm(); expect(seen).toEqual(['a','a','b']);
  });
  it('permanent rejection retains payload for repair and notifies; next job proceeds',async()=>{
    const f=fixture(); await enqueue(f.outbox,'a'); await enqueue(f.outbox,'b'); const notices=[];
    vi.stubGlobal('fetch',vi.fn(async(url,opts)=>{
      const b=JSON.parse(opts.body);
      if(url.includes('telegram')){notices.push(b.text);return Response.json({ok:true});}
      return b.requestId==='a'?new Response('',{status:400}):Response.json({taskId:'b',requestId:'b',durable:true});
    }));
    await f.outbox.alarm(); expect(f.data.has('failed:a')).toBe(true); expect(f.data.has('a:0')).toBe(true);
    expect(notices[0]).toContain('400'); await f.outbox.alarm(); expect(f.data.has('job:b')).toBe(false);
  });
});
describe('outbox failure boundaries',()=>{
  it('duplicate enqueue after delivery remains a tombstone, without restoring attachments',async()=>{
    const f=fixture(); await enqueue(f.outbox,'a',{fileBase64:'xyz'});
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({taskId:'u-a',requestId:'a',durable:true})));
    await f.outbox.alarm(); await enqueue(f.outbox,'a',{fileBase64:'xyz'});
    expect(f.data.has('job:a')).toBe(false);expect(f.data.has('a:0')).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([401,403,404,408,429,500,503])('HTTP %i remains retryable without discarding the payload',async(status)=>{
    const f=fixture();await enqueue(f.outbox,'a');
    vi.stubGlobal('fetch',vi.fn(async url=>url.includes('telegram')?Response.json({ok:true}):new Response('',{status})));
    await f.outbox.alarm();expect(f.data.has('job:a')).toBe(true);expect(f.data.has('a:0')).toBe(true);
    expect(f.alarm()).not.toBe(null);
  });
  it.each([{taskId:'legacy'}, {taskId:'wrong',requestId:'b',durable:true}])('does not accept an incompatible or mismatched ACK',async ack=>{
    const f=fixture();await enqueue(f.outbox,'a');
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json(ack)));
    await f.outbox.alarm();expect(f.data.has('job:a')).toBe(true);
  });
  it('FIFO uses durable insertion order even with identical timestamps and reversed IDs',async()=>{
    const f=fixture();vi.spyOn(Date,'now').mockReturnValue(1000);
    await enqueue(f.outbox,'z');await enqueue(f.outbox,'a');const seen=[];
    vi.stubGlobal('fetch',vi.fn(async(_url,opts)=>{const id=JSON.parse(opts.body).requestId;seen.push(id);return Response.json({taskId:id,requestId:id,durable:true});}));
    await f.outbox.alarm();expect(seen).toEqual(['z']);
    await f.outbox.alarm();expect(seen).toEqual(['z','a']);vi.restoreAllMocks();
  });
  it('storage failure never acknowledges acceptance',async()=>{
    const f=fixture();f.storage.transaction=async()=>{throw Error('disk unavailable');};
    await expect(enqueue(f.outbox,'a')).rejects.toThrow('disk unavailable');
  });
});
