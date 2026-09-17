import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../src/lib/telegram.js',()=>({answerCallbackQuery:vi.fn(),editMessage:vi.fn().mockResolvedValue({})}));
import {handleRestartConfirmation} from '../src/lib/restart-confirmations.js';
import {answerCallbackQuery,editMessage} from '../src/lib/telegram.js';
import {uiLifetime} from '../src/lib/transient-ui.js';
const handle='12345678-1234-1234-1234-123456789012';
const env={BOT_TOKEN:'fake',AGENT_URL:'https://main',AGENT_RU_URL:'https://ru',AGENT_SECRET:'fake'};
const cq={id:'callback',data:`ri:r:y:${handle}`,from:{id:42},message:{chat:{id:-100},message_thread_id:12,message_id:5,text:'Saved task'}};
describe('restart confirmation callback',()=>{
 beforeEach(()=>{vi.clearAllMocks();vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({decision:'confirm',accepted:true})}));});
 it('routes to issuing VM and uses actual callback sender, not stored actor or selected project',async()=>{
  await handleRestartConfirmation(cq,env,{username:'alice',telegramUserId:999,projectId:'new-project',activeSessionId:'new-session'});
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url,opts]=fetch.mock.calls[0];expect(url).toBe('https://ru/restart/decision');
  expect(JSON.parse(opts.body)).toEqual({handle,action:'confirm',username:'alice',telegramUserId:42,chatId:-100,threadId:12});
  expect(editMessage.mock.calls[0][3]).toContain('Подтверждение сохранено');
  expect(uiLifetime(cq.data)).toBeNull();
 });
 it('replayed opposite click shows winning server decision',async()=>{
  fetch.mockResolvedValue({ok:true,json:async()=>({accepted:false,replay:true,decision:'cancel'})});
  await handleRestartConfirmation(cq,env,{username:'alice'});
  expect(answerCallbackQuery.mock.calls[0][2]).toBe('Задача отменена.');
 });
 it('missing authentication and malformed handle never dispatch',async()=>{
  await handleRestartConfirmation(cq,env,null);
  await handleRestartConfirmation({...cq,data:'ri:r:y:bad'},env,{username:'alice'});
  expect(fetch).not.toHaveBeenCalled();
 });
 it('outage preserves keyboard for retry and never tries the other server',async()=>{
  fetch.mockRejectedValue(Error('lost ACK'));
  await handleRestartConfirmation(cq,env,{username:'alice'});
  expect(fetch).toHaveBeenCalledTimes(1);expect(editMessage).not.toHaveBeenCalled();
 });
 it('unavailable RU route never falls back to main',async()=>{
  await handleRestartConfirmation(cq,{...env,AGENT_RU_URL:null},{username:'alice'});
  expect(fetch).not.toHaveBeenCalled();
 });
});
