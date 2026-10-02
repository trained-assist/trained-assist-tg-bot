import { Miniflare, Response as MFResponse } from 'miniflare';
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'media-runtime-'));
let mf,downloads=0,transcriptions=0;
const fileSizes=new Map([['f',3],['large245',2450000],['large20',20*1024*1024]]);
try {
 const script=path.join(root,'worker.mjs');
 await build({entryPoints:['tests/fixtures/media-runtime-worker.js'],bundle:true,format:'esm',platform:'node',target:'es2022',outfile:script,external:['node:*']});
 mf=new Miniflare({modules:true,modulesRoot:root,scriptPath:script,compatibilityDate:'2024-01-01',compatibilityFlags:['nodejs_compat'],
  durableObjects:{INTAKE:{className:'IntakeBuffer',useSQLite:true},MEDIA_JOBS:{className:'MediaJob',useSQLite:true}},
  r2Buckets:['MEDIA_BUCKET'],kvNamespaces:['SESSIONS'],
  // Ф4 (#319): у воркера больше нет ключа Deepgram — распознавание идёт на агента
  // (PUT /intake-files → POST /action), поэтому в bindings адрес агента обязателен.
  bindings:{MEDIA_PIPELINE:'r2',BOT_TOKEN:'fake',AGENT_SECRET:'fake',AGENT_URL:'https://agent.test'},
  outboundService:async request=>{
   const url=new URL(request.url);
   if(url.pathname.endsWith('/getFile')) {const id=url.searchParams.get('file_id');return MFResponse.json({ok:true,result:{file_path:id,file_size:fileSizes.get(id)}});}
   if(url.pathname.includes('/file/')) {downloads++;const id=url.pathname.split('/').at(-1);return new MFResponse(id==='f'?new Uint8Array([1,2,3]):new Uint8Array(fileSizes.get(id)).fill(7));}
   // Модель агента ровно в объёме контракта Ф4: принял файл → вернул path;
   // /action → скил speech_transcribe вернул текст. Аудио обязано доехать целым.
   if(url.hostname==='agent.test') {
    if(url.pathname==='/intake-files'&&request.method==='PUT') {
     const id=url.searchParams.get('id');
     assert.deepEqual([...new Uint8Array(await request.arrayBuffer())],[1,2,3]);
     return MFResponse.json({id,name:'voice.ogg',mime:'audio/ogg',size:3,path:`media/intake-store/${id}/data`});
    }
    if(url.pathname==='/action') {
     const payload=await request.json();
     assert.equal(payload.tool,'speech_transcribe');
     transcriptions++;
     assert.ok(String(payload.params.source).startsWith('media/intake-store/'));
     return MFResponse.json({ok:true,result:{text:'workerd transcript',duration:1,language:'ru'}});
    }
    throw Error('Unexpected agent request '+url.pathname);
   }
   if(url.hostname==='api.telegram.org')return MFResponse.json({ok:true,result:{message_id:100}});
   throw Error('Unexpected outbound request');
  },
 });
 const kv=await mf.getKVNamespace('SESSIONS');await kv.put('42',JSON.stringify({username:'alice'}));
 const msg={chat:{id:42},message_id:7,voice:{file_id:'f',file_unique_id:'u',file_size:3}};
 const response=await mf.dispatchFetch('https://test/ingest',{method:'POST',body:JSON.stringify({msg})});
 assert.equal(response.status,200);const result=await response.json();assert.equal(result.queued,true);
 let items;
 for(let i=0;i<100;i++) {items=await (await mf.dispatchFetch('https://test/inspect')).json();if(items[0]?.msg?.transcript)break;await new Promise(r=>setTimeout(r,100));}
 assert.equal(items[0].msg.transcript,'workerd transcript');assert.equal(items[0].mediaPending,false);
 assert.equal(downloads,1);assert.equal(transcriptions,1);
 const stored=await mf.dispatchFetch(`https://test/internal/media?username=alice&id=${result.id}`,{headers:{authorization:'Bearer fake'}});
 assert.deepEqual([...new Uint8Array(await stored.arrayBuffer())],[1,2,3]);
 const forbidden=await mf.dispatchFetch(`https://test/internal/media?username=alice&id=${result.id}`);assert.equal(forbidden.status,401);
 await mf.dispatchFetch('https://test/ingest',{method:'POST',body:JSON.stringify({msg})});assert.equal(downloads,1);
 for(const [fileId,messageId] of [['large245',8],['large20',9]]) {
  const size=fileSizes.get(fileId);
  const received=await (await mf.dispatchFetch('https://test/ingest',{method:'POST',body:JSON.stringify({msg:{chat:{id:42},message_id:messageId,document:{file_id:fileId,file_name:'large.bin',file_size:size}}})})).json();
  let item;
  for(let i=0;i<100;i++) {const items=await (await mf.dispatchFetch('https://test/inspect')).json();item=items.find(x=>x.msg.message_id===messageId);if(item?.msg.fileRef)break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(item?.msg.fileRef?.size,size);
  const read=await mf.dispatchFetch(`https://test/internal/media?username=alice&id=${received.id}`,{headers:{authorization:'Bearer fake'}});
  const bytes=new Uint8Array(await read.arrayBuffer());assert.equal(bytes.byteLength,size);assert.ok(bytes.every(x=>x===7));
 }
 assert.equal(downloads,3);assert.equal(transcriptions,1);
 console.log('PASS: real workerd SQLite alarms + R2 checksum put + streaming STT + intake delivery + authenticated read + duplicate intake + 2.45/20 MiB originals');
} finally {if(mf)await mf.dispose();await fs.rm(root,{recursive:true,force:true});}
