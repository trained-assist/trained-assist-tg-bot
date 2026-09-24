import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveAudience, resolveBotId } from '../src/lib/bot-context.js';
import { runTask, getProjects, getProjectDecision, getSessions, stopTask } from '../src/lib/agent-client.js';

afterEach(() => vi.unstubAllGlobals());
const env = { AGENT_URL: 'https://agent.invalid', AGENT_SECRET: 'fixture', SESSION_NAMESPACE: 'freelance', BOT_ID: 'sales-bot' };
const response = data => ({ ok: true, json: async () => data });
describe('generic bot context', () => {
  it('keeps audience and delivery bot independent, with backward-compatible defaults', () => {
    expect(resolveAudience({})).toBe('default');
    expect(resolveBotId({})).toBe('default');
    expect(resolveAudience(env)).toBe('freelance');
    expect(resolveBotId(env)).toBe('sales-bot');
    expect(resolveAudience({ SESSION_NAMESPACE:'recruiter' })).toBe('recruiter');
  });
  it.each(['../other', 'x:y', 'a'.repeat(33), 123, true])('rejects invalid deployment identity %j', value => {
    expect(() => resolveAudience({ SESSION_NAMESPACE: value })).toThrow();
    expect(() => resolveBotId({ BOT_ID: value })).toThrow();
  });
  it('forwards generic audience across all existing list/decision endpoints', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ projects: [], sessions: [], action:'create', choices:[] }));
    vi.stubGlobal('fetch', fetch);
    await getProjects(env, { username:'alice' });
    await getProjectDecision(env, { username:'alice', chatId:42 });
    await getSessions(env, { username:'alice' });
    expect(fetch).toHaveBeenCalledTimes(3);
    for (const [url] of fetch.mock.calls) expect(new URL(url).searchParams.get('audience')).toBe('freelance');
  });
  it('passes botId, not BOT_TOKEN, in both direct ingress and durable outbox payload', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ taskId:'accepted' }));
    vi.stubGlobal('fetch', fetch);
    const run = { username:'alice', userId:42, task:'work', requestId:'r1' };
    await runTask({ ...env, BOT_TOKEN:'private-token' }, run);
    const direct = JSON.parse(fetch.mock.calls[0][1].body);
    expect(direct).toMatchObject({ audience:'freelance', botId:'sales-bot', chatId:42 });
    expect(JSON.stringify(direct)).not.toContain('private-token');
    const queued = vi.fn().mockResolvedValue(response({ queued:true }));
    const idFromName = vi.fn(x => x);
    const RUN_OUTBOX = { idFromName, get: () => ({ fetch:queued }) };
    await runTask({ ...env, RUN_OUTBOX }, run);
    expect(JSON.parse(queued.mock.calls[0][1].body).body).toMatchObject({ audience:'freelance', botId:'sales-bot', requestId:'r1' });
    expect(idFromName).toHaveBeenLastCalledWith('freelance:sales-bot:alice:42');
    await runTask({ AGENT_URL:env.AGENT_URL, RUN_OUTBOX }, run);
    expect(idFromName).toHaveBeenLastCalledWith('alice:42');
  });
  it('always scopes stop by chat and audience; never falls back to profile-wide stop', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ killed:1 }));
    vi.stubGlobal('fetch', fetch);
    await expect(stopTask(env, { username:'alice' })).rejects.toThrow('chatId');
    expect(fetch).not.toHaveBeenCalled();
    await stopTask(env, { username:'alice', chatId:42, sessionId:'session-one' });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ username:'alice', chatId:42, sessionId:'session-one', audience:'freelance' });
  });
});
