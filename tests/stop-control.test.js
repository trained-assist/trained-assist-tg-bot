import { describe, it, expect, vi, beforeEach } from 'vitest';
const dispatch = vi.hoisted(() => vi.fn());
vi.mock('../src/handlers/message.js', () => ({ handleMessage: (...a) => dispatch(...a) }));
import { IntakeBuffer } from '../src/intake-buffer.js';
import { handleCommand } from '../src/handlers/commands.js';
import { handleCallbackQuery } from '../src/handlers/callbacks.js';

let env, states, buffers, requests, kv, controls;
const response = x => new Response(JSON.stringify(x), { status: 200 });
function world() {
  states = new Map(); buffers = new Map(); requests = []; controls = [];
  kv = new Map([['11', JSON.stringify({ username: 'shared', lastSessionId: 'a' })],
    ['22', JSON.stringify({ username: 'shared', lastSessionId: 'b' })]]);
  env = { BOT_TOKEN: 'token', AGENT_URL: 'https://agent.test', AGENT_SECRET: 'secret',
    SESSIONS: { get: async k => kv.get(k), put: async (k,v) => kv.set(k,v), delete: async k => kv.delete(k) },
    INTAKE: { idFromName: String, get: key => {
      if (!buffers.has(key)) {
        const map = new Map(); states.set(key, map);
        const state = { storage: { get: async k => map.get(k), put: async (k,v) => map.set(k,structuredClone(v)),
          delete: async k => map.delete(k), setAlarm: async t => map.set('alarm',t), deleteAlarm: async () => map.delete('alarm') } };
        const io = new IntakeBuffer(state,env);
        buffers.set(key, { io, fetch: (url,init) => io.fetch(new Request(url,init)) });
      }
      return buffers.get(key);
    } },
  };
  let mid=0;
  vi.stubGlobal('fetch', vi.fn(async (url,init) => {
    const body=JSON.parse(init?.body || '{}'); requests.push({url:String(url),body});
    if (String(url).includes('/tasks/control')) {
      controls.push(body);
      return response({ ok:true, epoch:1, killed:1, sessionId:body.sessionId,
        held: body.action==='resume' ? [{ taskId:'saved-task',task:'saved important input' }] : [] });
    }
    return response({ ok:true,result:{message_id:++mid} });
  }));
}
beforeEach(() => { vi.clearAllMocks(); dispatch.mockResolvedValue({}); world(); });
const command=(id,text)=>handleCommand({chat:{id,type:'private'},from:{id:99},text},env);
const append=(id,text)=>env.INTAKE.get(String(id)).fetch('https://intake/append',{method:'POST',body:JSON.stringify({text,msg:{chat:{id},text,message_id:Date.now()}})});
const flush=id=>env.INTAKE.get(String(id)).fetch('https://intake/flush',{method:'POST'});

describe('session stop protocol',()=>{
  it('/stop scopes one chat, retains both buffers, and resumes only on explicit launch',async()=>{
    await append(11,'first chat'); await append(22,'other chat');
    await command(11,'/stop');
    expect(controls[0]).toMatchObject({ username:'shared',chatId:11,sessionId:'a',action:'stop' });
    expect(states.get('11').get('paused')).toBe(true);
    expect(states.get('22').get('paused')).toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
    await flush(11);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0].text).toContain('saved important input');
    expect(dispatch.mock.calls[0][0].text).toContain('first chat');
    expect(dispatch.mock.calls[0][2]).toMatchObject({ controlEpoch:1 });
    expect(controls.map(c=>c.action)).toEqual(['stop','resume','ack']);
    expect(states.get('22').get('buf')[0].text).toBe('other chat');
  });
  it('can resume stopped work with an empty intake buffer',async()=>{
    await command(11,'/stop'); await flush(11);
    expect(dispatch.mock.calls[0][0].text).toContain('saved important input');
  });
  it('/skip launches accumulated new information without pausing the session',async()=>{
    await append(11,'new important information'); await command(11,'/skip');
    expect(controls[0]).toMatchObject({ chatId:11,sessionId:'a',action:'skip' });
    expect(dispatch.mock.calls[0][0].text).toContain('new important information');
    expect(states.get('11').get('paused')).toBeUndefined();
  });
  it('/fresh archives pending input and creates a valid new session id',async()=>{
    await append(11,'old input'); await command(11,'/fresh');
    expect(states.get('11').get('buf')).toBeUndefined();
    expect([...states.get('11').entries()].some(([k,v])=>k.startsWith('archived:') && v[0].text==='old input')).toBe(true);
    expect(JSON.parse(kv.get('11')).activeSessionId).toMatch(/^s-11-\d+$/);
  });
  it('rejects an obsolete stop button before pausing the intake',async()=>{
    const original=fetch;
    vi.stubGlobal('fetch',vi.fn(async(url,init)=>String(url).includes('/tasks/control')
      ? new Response('{}',{status:409}) : original(url,init)));
    await handleCallbackQuery({id:'cb',data:'stop|old-task',message:{chat:{id:11},message_id:9},from:{id:99}},env);
    expect(states.get('11')?.get('paused')).not.toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('controls both configured agents with the same chat scope',async()=>{
    env.AGENT_RU_URL='https://ru.test';
    await command(11,'/stop');
    expect(controls).toHaveLength(2);
    expect(controls.every(c=>c.chatId===11 && c.sessionId==='a')).toBe(true);
    await flush(11);
    expect(dispatch.mock.calls[0][2].controlEpochs).toEqual({'https://agent.test':1,'https://ru.test':1});
  });
});

it('registers controls for both private/group menus once, preserves domain commands, never in staging',async()=>{
  const { ensureControlCommands } = await import('../src/lib/control-commands.js');
  await ensureControlCommands(env);
  expect(requests).toEqual([]);
  env.CONTROL_COMMANDS_ENABLED='on';
  await ensureControlCommands(env);
  const sets=requests.filter(r=>r.url.endsWith('/setMyCommands'));
  expect(sets).toHaveLength(6);
  expect(sets.every(r=>r.body.commands.some(c=>c.command==='skip'))).toBe(true);
  await ensureControlCommands(env);
  expect(requests.filter(r=>r.url.endsWith('/setMyCommands'))).toHaveLength(6);
});

it('fresh during a failing in-flight dispatch never restores excluded input',async()=>{
  let reject;
  dispatch.mockImplementationOnce(()=>new Promise((_,r)=>{reject=r}));
  await append(11,'old in flight');
  const running=flush(11);
  for(let i=0;i<20 && !reject;i++) await new Promise(r=>setTimeout(r,1));
  expect(reject).toBeTypeOf('function');
  await command(11,'/fresh');
  reject(new Error('cancelled during preparation'));
  await running;
  expect(states.get('11').get('buf')).toBeUndefined();
  expect([...states.get('11').keys()].some(k=>k.startsWith('archived-dispatch:'))).toBe(true);
});
