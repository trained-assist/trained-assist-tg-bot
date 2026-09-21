import {it,expect,vi,afterEach} from 'vitest';
import {handleCommand} from '../src/handlers/commands.js';
import registry from '../commands-registry.json';
import {readFileSync} from 'node:fs';
afterEach(()=>vi.unstubAllGlobals());
it('any logged-in profile can request the hidden restart command',async()=>{
 const calls=[];
 vi.stubGlobal('fetch',vi.fn(async(url,opts)=>{calls.push({url,body:opts?.body?JSON.parse(opts.body):null});return String(url).includes('/maintenance')?Response.json({phase:'restarting',paused:false,active:0}):Response.json({ok:true,result:{message_id:1}});}));
 const env={BOT_TOKEN:'test',AGENT_URL:'https://agent',AGENT_SECRET:'secret',SESSIONS:{get:async()=>JSON.stringify({username:'ordinary-engineer'})}};
 await handleCommand({chat:{id:123},from:{id:123},text:'/restart',message_thread_id:77},env);
 expect(calls.find(c=>c.url.endsWith('/maintenance')).body).toEqual({action:'request',initiator:{username:'ordinary-engineer',chatId:123,threadId:77}});
 expect(calls.some(c=>c.body?.text?.includes('Перезапускаюсь'))).toBe(true);
 expect(registry.commands.find(c=>c.command==='/restart').hidden).toBe(true);
 expect(readFileSync(new URL('../scripts/set-commands.js',import.meta.url),'utf8')).not.toMatch(/command:\s*['"]restart['"]/);
});
it('restart never announces a pause or a queue',async()=>{
 const texts=[];
 vi.stubGlobal('fetch',vi.fn(async(url,opts)=>{if(String(url).endsWith('/maintenance'))return Response.json({phase:'ready',paused:false});texts.push(JSON.parse(opts.body).text);return Response.json({ok:true});}));
 await handleCommand({chat:{id:123},text:'/restart status'},{BOT_TOKEN:'test',AGENT_URL:'https://agent',AGENT_SECRET:'secret',SESSIONS:{get:async()=>JSON.stringify({username:'u'})}});
 expect(texts[0]).toBe('✅ Сервер работает.');expect(texts[0]).not.toMatch(/⏸|запланирован|сохраня/);
});
