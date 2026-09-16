import { describe, it, expect, vi, afterEach } from 'vitest';
import { MediaJob, mediaId, objectKey, serveMedia, digest } from '../src/media-jobs.js';
import { IntakeBuffer } from '../src/intake-buffer.js';
import { prepareIntake } from '../src/intake-preflight.js';
import { copyRefsToAgent } from '../src/lib/intake-files.js';
vi.mock('../src/lib/telegram.js', () => ({ sendMessage: vi.fn(async () => ({ok:true})), sendDocument: vi.fn(), sendMessageWithKeyboard: vi.fn(async()=>({result:{message_id:100}})), editMessage: vi.fn(async()=>({ok:true})), editMessageReplyMarkup: vi.fn(async()=>({ok:true})) }));
vi.mock('../src/lib/kv.js', () => ({ getSession: vi.fn(async()=>({username:'alice'})), setSession: vi.fn() }));
function state() {
  const data = new Map(); let alarm;
  const storage = {get: async k=>structuredClone(data.get(k)), put:async(k,v)=>data.set(k,structuredClone(v)), delete:async k=>data.delete(k),
    getAlarm:async()=>alarm ?? null,setAlarm:async t=>{alarm=t;},deleteAlarm:async()=>{alarm=null;},transaction:async fn=>fn(storage)};
  return {storage,data,get alarm(){return alarm;}};
}
function bucket() {
  const data = new Map();
  const get=async k=>{const v=data.get(k);return v && {...v,body:new Response(v.bytes).body,text:async()=>new TextDecoder().decode(v.bytes)};};
  return {data,get,head:get,put:vi.fn(async(k,bytes,meta)=>{const v={...meta,size:bytes.byteLength,bytes:new Uint8Array(bytes)};data.set(k,v);return v;})};
}
const msg={chat:{id:42},message_id:7,voice:{file_id:'f',file_unique_id:'u',file_size:3}};
async function fixture(message=msg) {
 const s=state(),b=bucket(),intake=state();
 const env={MEDIA_BUCKET:b,MEDIA_PIPELINE:'r2',BOT_TOKEN:'test',DEEPGRAM_API_KEY:'test',SESSIONS:{},AGENT_SECRET:'secret'};
 const jobs=new Map();
 env.MEDIA_JOBS={idFromName:n=>n,get:n=>{if(!jobs.has(n))jobs.set(n,new MediaJob(s,env));return {fetch:(u,o)=>jobs.get(n).fetch(new Request(u,o))};}};
 const io=new IntakeBuffer(intake,env);
 env.INTAKE={idFromName:n=>n,get:()=>({fetch:(u,o)=>io.fetch(new Request(u,o))})};
 const net=vi.fn(async url=>{
  if(String(url).includes('/getFile'))return Response.json({ok:true,result:{file_path:'voice.ogg',file_size:3}});
  if(String(url).includes('/file/'))return new Response(new Uint8Array([1,2,3]));
  if(String(url).includes('deepgram'))return Response.json({results:{channels:[{alternatives:[{transcript:'Привет'}]}]}});
  throw Error('Unexpected network '+url);
 });vi.stubGlobal('fetch',net);
 await io.fetch(new Request('https://intake/ingest',{method:'POST',body:JSON.stringify({msg:message})}));
 const job=[...jobs.values()][0];return {s,b,intake,env,io,job,net};
}
afterEach(()=>vi.unstubAllGlobals());
describe('durable R2 pipeline',()=>{
 it('ACKs before bytes; voice downloads once, survives restart, then delivers refs and transcript',async()=>{
  const f=await fixture();expect(f.net).not.toHaveBeenCalled();expect(f.intake.data.get('buf')[0].mediaPending).toBe(true);
  await f.job.alarm();expect(f.s.data.get('job').stage).toBe('transcribe');
  const restarted=new MediaJob(f.s,f.env);await restarted.alarm();await restarted.alarm();
  expect(f.s.data.get('job').stage).toBe('done');
  expect(f.net.mock.calls.filter(([u])=>String(u).includes('/file/'))).toHaveLength(1);
  const prepared=f.intake.data.get('buf')[0].msg;expect(prepared.transcript).toBe('Привет');
  expect(prepared.fileRef.storage).toBe('r2');expect(prepared.transcriptRef.storage).toBe('r2');
  const n=f.net.mock.calls.length;expect(await prepareIntake(prepared,f.env,{username:'alice'})).toEqual(prepared);
  await copyRefsToAgent(f.env,'alice',[prepared.fileRef],'https://regional');expect(f.net).toHaveBeenCalledTimes(n);
 });
 it('deduplicates Telegram updates and result redelivery',async()=>{
  const f=await fixture();for(let i=0;i<3;i++)await f.job.alarm();
  await f.io.fetch(new Request('https://intake/ingest',{method:'POST',body:JSON.stringify({msg})}));
  await f.job.fetch(new Request('https://media/enqueue',{method:'POST',body:JSON.stringify({msg,username:'alice',retry:true})}));
  await f.job.alarm();expect(f.intake.data.get('buf')).toHaveLength(1);expect(f.b.put).toHaveBeenCalledTimes(2);
 });
 it('transcription retries reuse original; exhaustion parks failed media and permits new text',async()=>{
  const f=await fixture();await f.job.alarm();
  f.net.mockImplementation(async()=>new Response('temporary',{status:503}));
  for(let i=0;i<3;i++)await f.job.alarm();expect(f.s.data.get('job').stage).toBe('notify-failure');
  await f.job.alarm();expect(f.s.data.get('job').stage).toBe('failed');expect(f.intake.data.get('buf')).toHaveLength(0);
  expect(f.intake.data.has(`media-failed:${await mediaId(msg)}`)).toBe(true);expect(f.b.data.size).toBe(1);
  await f.io.fetch(new Request('https://intake/append',{method:'POST',body:JSON.stringify({msg:{chat:{id:42},message_id:8,text:'new task'},text:'new task'})}));
  expect(f.intake.data.get('buf')[0].text).toBe('new task');expect(f.intake.data.get('busy')).toBeUndefined();
 });
 it('recovers a reserved job after enqueue interruption without a two-minute timeout bypass',async()=>{
  const f=await fixture();f.s.data.clear();await f.io._recoverMedia();expect(f.s.data.get('job').stage).toBe('download');
  const buf=f.intake.data.get('buf');buf[0].preparingAt=Date.now()-300000;f.intake.data.set('buf',buf);
  const result=await f.io.fetch(new Request('https://intake/flush',{method:'POST'}));expect(await result.json()).toEqual({preparing:true});
 });
 it('photo and PDF skip transcription, retain caption and metadata',async()=>{
  for(const extra of [{photo:[{file_id:'p',file_unique_id:'p'}]}, {document:{file_id:'d',file_name:'doc.pdf',mime_type:'application/pdf'}}]) {
   const f=await fixture({chat:{id:42},message_id:9,caption:'Посмотри',...extra});await f.job.alarm();await f.job.alarm();
   expect(f.s.data.get('job').stage).toBe('done');expect(f.intake.data.get('buf')[0].msg.caption).toBe('Посмотри');
   expect(f.net.mock.calls.some(([u])=>String(u).includes('deepgram'))).toBe(false);
  }
 });
 it('rejects oversize and truncated originals without saving partial objects',async()=>{
  const f=await fixture();f.net.mockImplementation(async url=>String(url).includes('/getFile')?Response.json({ok:true,result:{file_path:'x',file_size:4}}):new Response('123'));
  await f.job.alarm();expect(f.b.data.size).toBe(0);expect(f.s.data.get('job').attempts).toBe(1);
  const job=f.s.data.get('job');job.msg.voice.file_size=21*1024*1024;f.s.data.set('job',job);await f.job.alarm();
  expect(f.s.data.get('job').stage).toBe('notify-failure');expect(f.b.data.size).toBe(0);
 });
 it('reuses a committed original after crash before state transition',async()=>{
  const f=await fixture();const original=structuredClone(f.s.data.get('job'));await f.job.alarm();f.s.data.set('job',original);
  const calls=f.net.mock.calls.length;await f.job.alarm();expect(f.net).toHaveBeenCalledTimes(calls);expect(f.b.put).toHaveBeenCalledTimes(1);
 });
 it('delivery failure retries without retranscribing',async()=>{
  const f=await fixture();await f.job.alarm();await f.job.alarm();
  const real=f.env.INTAKE;f.env.INTAKE={idFromName:n=>n,get:()=>({fetch:async()=>new Response('',{status:503})})};
  await f.job.alarm();expect(f.s.data.get('job').stage).toBe('deliver');const calls=f.net.mock.calls.length;
  f.env.INTAKE=real;await f.job.alarm();expect(f.s.data.get('job').stage).toBe('done');expect(f.net).toHaveBeenCalledTimes(calls);
 });
 it('reconciliation rearms a stranded active job without repeating a completed phase',async()=>{
  const f=await fixture();await f.job.alarm();await f.s.storage.deleteAlarm();await f.io._recoverMedia();
  expect(f.s.alarm).toBeGreaterThan(0);expect(f.s.data.get('job').stage).toBe('transcribe');expect(f.b.put).toHaveBeenCalledTimes(1);
 });
 it('honors short Retry-After without keeping the intake request open',async()=>{
  const f=await fixture();await f.job.alarm();
  f.net.mockImplementation(async()=>new Response('rate limited',{status:429,headers:{'Retry-After':'30'}}));
  const before=Date.now();await f.job.alarm();expect(f.s.alarm).toBeGreaterThanOrEqual(before+30000);expect(f.s.data.get('job').stage).toBe('transcribe');
  f.net.mockImplementation(async()=>new Response('rate limited',{status:429,headers:{'Retry-After':'3600'}}));
  await f.job.alarm();expect(f.s.data.get('job').stage).toBe('notify-failure');
 });
 it('queue outage parks the reservation after bounded retries',async()=>{
  const f=await fixture();f.env.MEDIA_JOBS={idFromName:n=>n,get:()=>({fetch:async()=>{throw Error('down');}})};
  for(let i=0;i<3;i++)await f.io._recoverMedia();
  expect(f.intake.data.get('buf')).toHaveLength(0);
  expect(f.intake.data.has(`media-failed:${await mediaId(msg)}`)).toBe(true);
 });
 it('pending media does not hold the mutation lock while accepting new text',async()=>{
  const f=await fixture();
  await f.io.fetch(new Request('https://intake/append',{method:'POST',body:JSON.stringify({msg:{chat:{id:42},message_id:8,text:'text'},text:'text'})}));
  expect(f.intake.data.get('buf')).toHaveLength(2);expect(f.net).not.toHaveBeenCalled();
 });
 it('authenticates object reads and isolates tenant keys',async()=>{
  const f=await fixture();await f.job.alarm();const id=await mediaId(msg);
  const url=`https://gateway/internal/media?username=alice&id=${id}`;
  expect((await serveMedia(new Request(url),f.env)).status).toBe(401);
  const read=await serveMedia(new Request(url,{headers:{authorization:'Bearer secret'}}),f.env);expect([...new Uint8Array(await read.arrayBuffer())]).toEqual([1,2,3]);
  expect((await serveMedia(new Request(url.replace('alice','bob'),{headers:{authorization:'Bearer secret'}}),f.env)).status).toBe(404);
  expect(()=>objectKey('../alice',id)).toThrow();
 });
});
