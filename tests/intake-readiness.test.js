import { it, expect, vi, afterEach } from 'vitest';
import { intakeReadiness } from '../src/intake-readiness.js';
const env = { INTAKE: {}, SESSIONS: {}, DEEPGRAM_API_KEY: 'stt', AGENT_SECRET: 's', AGENT_URL: 'https://main/agent', AGENT_RU_URL: 'https://ru/agent' };
afterEach(() => vi.unstubAllGlobals());
it('requires authenticated validation from every configured backend, never runs a task', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'invalid intake request' }, { status: 400 })));
  expect((await intakeReadiness(env)).ready).toBe(true);
  expect(fetch.mock.calls.map(([u]) => u)).toEqual(['https://main/agent/intake-quick', 'https://ru/agent/intake-quick']);
  expect(fetch.mock.calls.every(([,o]) => o.body === '{}' && o.headers.Authorization === 'Bearer s')).toBe(true);
});
for (const status of [200,401,404,500]) it(`HTTP ${status} cannot masquerade as working quick answers`, async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'alive' }, { status })));
  expect((await intakeReadiness(env)).ready).toBe(false);
});
it('offline optional region uses the same primary fallback as message routing', async () => {
  vi.stubGlobal('fetch', vi.fn(async u => {
    if (u.includes('//ru')) throw new Error('network');
    return Response.json({ error: 'invalid intake request' }, { status: 400 });
  }));
  expect(await intakeReadiness(env)).toMatchObject({ ready: true, backends: [true, false], regionalFallback: true });
});
it('disabled intake cannot pass release verification', async () => {
  expect((await intakeReadiness({ ...env, INTAKE_DEBOUNCE: 'off' })).ready).toBe(false);
});

it('online regional routing with missing quick route fails the release', async () => {
  vi.stubGlobal('fetch', vi.fn(async u => {
    if (u.includes('/capabilities?')) return Response.json({ capabilities: [] });
    if (u.includes('//ru')) return new Response('Not found', { status: 404 });
    return Response.json({ error: 'invalid intake request' }, { status: 400 });
  }));
  expect(await intakeReadiness(env)).toMatchObject({ ready: false, backendStatuses: [400,404], regionalFallback: false });
});
