import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runTask, getSessions, stopTask } from '../src/lib/agent-client.js';
import { resolveAudience } from '../src/lib/audience.js';

describe('resolveAudience', () => {
  it('maps SESSION_NAMESPACE to the wire audience, default when unset', () => {
    expect(resolveAudience({})).toBe('default');
    expect(resolveAudience({ SESSION_NAMESPACE: 'recruiter' })).toBe('recruiter');
    expect(resolveAudience({ SESSION_NAMESPACE: 'freelance' })).toBe('freelance');
  });
});

const BASE = 'https://gcp.example.com';
const USER = 'testuser';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it('durable dispatch keeps original request time and forum topic before network delivery', async () => {
  const { runTask } = await import('../src/lib/agent-client.js');
  const delivered = [];
  const env = { AGENT_URL: BASE, RUN_OUTBOX: {
    idFromName: x => x, get: () => ({ fetch: async (_, options) => {
      delivered.push(JSON.parse(options.body)); return Response.json({queued:true,outbox:true});
    } }),
  } };
  await runTask(env,{userId:-10,username:USER,task:'work',requestId:'one',initiatedAt:1234,threadId:42});
  expect(delivered[0].body).toMatchObject({initiatedAt:1234,threadId:42,requestId:'one'});
});

// Cross-bot session leak fix: the backend keys sessions/projects by username+chatId
// alone, so requests from the recruiter bot and the default bot for the same human
// must be tagged with distinct `audience` values or they mix each other's sessions.
describe('runTask sends audience derived from SESSION_NAMESPACE', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends audience: "default" when SESSION_NAMESPACE is not set', async () => {
    const { runTask } = await import('../src/lib/agent-client.js');
    const fetchSpy = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchSpy);
    const env = { AGENT_URL: BASE, AGENT_SECRET: 'x' };
    await runTask(env, { userId: 1, username: USER, task: 'work' });
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.audience).toBe('default');
  });

  it('sends audience: "recruiter" when SESSION_NAMESPACE is "recruiter"', async () => {
    const { runTask } = await import('../src/lib/agent-client.js');
    const fetchSpy = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchSpy);
    const env = { AGENT_URL: BASE, AGENT_SECRET: 'x', SESSION_NAMESPACE: 'recruiter' };
    await runTask(env, { userId: 1, username: USER, task: 'work' });
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.audience).toBe('recruiter');
  });

  it('sends audience: "freelance" when SESSION_NAMESPACE is "freelance"', async () => {
    const { runTask } = await import('../src/lib/agent-client.js');
    const fetchSpy = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchSpy);
    const env = { AGENT_URL: BASE, AGENT_SECRET: 'x', SESSION_NAMESPACE: 'freelance' };
    await runTask(env, { userId: 1, username: USER, task: 'work' });
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.audience).toBe('freelance');
  });
});

// P1-B of naming-conventions refactor (plan generic-naming-conventions-refactoring §4):
// dual-send chatId alongside legacy userId so agent's /run can migrate off userId later
// without a synchronized deploy.
describe('runTask sends chatId as an alias of userId', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('mirrors userId into chatId on the wire body', async () => {
    const { runTask } = await import('../src/lib/agent-client.js');
    const fetchSpy = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchSpy);
    const env = { AGENT_URL: BASE, AGENT_SECRET: 'x' };
    await runTask(env, { userId: 555, username: USER, task: 'work' });
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.userId).toBe(555);
    expect(body.chatId).toBe(555);
  });

  it('mirrors userId into chatId on the durable outbox path too', async () => {
    const { runTask } = await import('../src/lib/agent-client.js');
    const delivered = [];
    const env = { AGENT_URL: BASE, RUN_OUTBOX: {
      idFromName: x => x, get: () => ({ fetch: async (_, options) => {
        delivered.push(JSON.parse(options.body)); return Response.json({ queued: true, outbox: true });
      } }),
    } };
    await runTask(env, { userId: -10, username: USER, task: 'work' });
    expect(delivered[0].body.userId).toBe(-10);
    expect(delivered[0].body.chatId).toBe(-10);
  });
});

describe('getSessions sends audience derived from SESSION_NAMESPACE', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('appends audience=default when SESSION_NAMESPACE is not set', async () => {
    const { getSessions } = await import('../src/lib/agent-client.js');
    const fetchSpy = vi.fn().mockResolvedValue(Response.json({ sessions: [] }));
    vi.stubGlobal('fetch', fetchSpy);
    const env = { AGENT_URL: BASE, AGENT_SECRET: 'x' };
    await getSessions(env, { username: USER });
    expect(fetchSpy.mock.calls[0][0]).toContain('audience=default');
  });

  it('appends audience=recruiter when SESSION_NAMESPACE is "recruiter"', async () => {
    const { getSessions } = await import('../src/lib/agent-client.js');
    const fetchSpy = vi.fn().mockResolvedValue(Response.json({ sessions: [] }));
    vi.stubGlobal('fetch', fetchSpy);
    const env = { AGENT_URL: BASE, AGENT_SECRET: 'x', SESSION_NAMESPACE: 'recruiter' };
    await getSessions(env, { username: USER });
    expect(fetchSpy.mock.calls[0][0]).toContain('audience=recruiter');
  });

  it('appends audience=freelance when SESSION_NAMESPACE is "freelance"', async () => {
    const { getSessions } = await import('../src/lib/agent-client.js');
    const fetchSpy = vi.fn().mockResolvedValue(Response.json({ sessions: [] }));
    vi.stubGlobal('fetch', fetchSpy);
    const env = { AGENT_URL: BASE, AGENT_SECRET: 'x', SESSION_NAMESPACE: 'freelance' };
    await getSessions(env, { username: USER });
    expect(fetchSpy.mock.calls[0][0]).toContain('audience=freelance');
  });
});

describe('getProjects sends audience derived from SESSION_NAMESPACE', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('appends audience=default when SESSION_NAMESPACE is not set', async () => {
    const { getProjects } = await import('../src/lib/agent-client.js');
    const fetchSpy = vi.fn().mockResolvedValue(Response.json({ projects: [] }));
    vi.stubGlobal('fetch', fetchSpy);
    const env = { AGENT_URL: BASE, AGENT_SECRET: 'x' };
    await getProjects(env, { username: USER, userId: 1 });
    expect(fetchSpy.mock.calls[0][0]).toContain('audience=default');
  });

  it('appends audience=recruiter when SESSION_NAMESPACE is "recruiter"', async () => {
    const { getProjects } = await import('../src/lib/agent-client.js');
    const fetchSpy = vi.fn().mockResolvedValue(Response.json({ projects: [] }));
    vi.stubGlobal('fetch', fetchSpy);
    const env = { AGENT_URL: BASE, AGENT_SECRET: 'x', SESSION_NAMESPACE: 'recruiter' };
    await getProjects(env, { username: USER, userId: 1 });
    expect(fetchSpy.mock.calls[0][0]).toContain('audience=recruiter');
  });

  it('appends audience=freelance when SESSION_NAMESPACE is "freelance"', async () => {
    const { getProjects } = await import('../src/lib/agent-client.js');
    const fetchSpy = vi.fn().mockResolvedValue(Response.json({ projects: [] }));
    vi.stubGlobal('fetch', fetchSpy);
    const env = { AGENT_URL: BASE, AGENT_SECRET: 'x', SESSION_NAMESPACE: 'freelance' };
    await getProjects(env, { username: USER, userId: 1 });
    expect(fetchSpy.mock.calls[0][0]).toContain('audience=freelance');
  });
});

// #1318: the agent pins the chat ONLY on projectPicked:true + projectId.
describe('runTask projectPicked wire field', () => {
  afterEach(() => vi.unstubAllGlobals());
  const send = async args => {
    const fetchSpy = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchSpy);
    await runTask({ AGENT_URL: BASE, AGENT_SECRET: 'x' }, { userId: 1, username: USER, task: 'work', ...args });
    return JSON.parse(fetchSpy.mock.calls[0][1].body);
  };
  it('sends projectPicked:true with projectId for an explicit menu choice', async () => {
    expect(await send({ projectId: 'p1', projectPicked: true })).toMatchObject({ projectId: 'p1', projectPicked: true });
  });
  it('omits projectPicked for auto/remembered ids and when there is no projectId', async () => {
    expect(await send({ projectId: 'p1' })).not.toHaveProperty('projectPicked');
    expect(await send({ projectId: 'p1', projectPicked: false })).not.toHaveProperty('projectPicked');
    expect(await send({ projectPicked: true })).not.toHaveProperty('projectPicked');
  });
});

// #302/#326 (решение 02.10.2026): выбор машины ушёл из бота — стоп всегда идёт
// на единственный адрес и возвращает ответ агента как есть.
describe('stopTask — один адрес (#302)', () => {
  it('ходит только на AGENT_URL и возвращает ответ агента', async () => {
    const seen = [];
    vi.stubGlobal('fetch', vi.fn(async url => {
      seen.push(String(url));
      return { ok: true, json: async () => ({ killed: 2 }) };
    }));
    const res = await stopTask({ AGENT_URL: BASE, AGENT_SECRET: 's' }, { username: USER, chatId: 42 });
    expect(seen).toEqual([`${BASE}/tasks/stop`]);
    expect(res).toEqual({ killed: 2 });
  });

  it('падает, если агент недоступен', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    await expect(stopTask({ AGENT_URL: BASE, AGENT_SECRET: 's' }, { username: USER, chatId: 42 }))
      .rejects.toThrow('down');
  });
});
