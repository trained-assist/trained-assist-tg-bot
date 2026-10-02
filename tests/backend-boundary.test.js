import { afterEach, describe, expect, it, vi } from 'vitest';

// #326 — граница backend. Подача задачи выбирает VM (pickAgentUrl), но стоп и
// busy-пол не должны вычислять адресат заново: они фанаутятся на все настроенные
// backend'ы, чтобы найти задачу, ушедшую на региональный VM. Карта — docs/backend-boundary.md.
import { agentBases, stopTask } from '../src/lib/agent-client.js';

const BASE = 'https://agent';
const RU = 'https://ru';
const env = extra => ({ AGENT_URL: BASE, AGENT_SECRET: 's', SESSION_NAMESPACE: 'recruiter', ...extra });

afterEach(() => vi.unstubAllGlobals());

describe('agentBases', () => {
  it('lists the configured backends, deduped, dropping undefined', () => {
    expect(agentBases(env())).toEqual([BASE]);
    expect(agentBases(env({ AGENT_RU_URL: RU }))).toEqual([BASE, RU]);
    expect(agentBases(env({ AGENT_RU_URL: BASE }))).toEqual([BASE]);
  });
});

describe('stopTask fans out to every backend (#326)', () => {
  it('stops on primary + regional and sums killed', async () => {
    const seen = [];
    vi.stubGlobal('fetch', vi.fn(async url => {
      seen.push(String(url));
      return { ok: true, json: async () => ({ killed: String(url).startsWith(RU) ? 2 : 1 }) };
    }));
    const res = await stopTask(env({ AGENT_RU_URL: RU }), { username: 'u', chatId: 42, threadId: 7 });
    expect(seen).toEqual([`${BASE}/tasks/stop`, `${RU}/tasks/stop`]);
    expect(res).toEqual({ killed: 3 });
  });

  it('a regional hiccup does not fail a successful primary stop', async () => {
    vi.stubGlobal('fetch', vi.fn(async url => {
      if (String(url).startsWith(RU)) throw new Error('boom');
      return { ok: true, json: async () => ({ killed: 1 }) };
    }));
    await expect(stopTask(env({ AGENT_RU_URL: RU }), { username: 'u', chatId: 42 }))
      .resolves.toEqual({ killed: 1 });
  });

  it('throws only when no backend could be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    await expect(stopTask(env({ AGENT_RU_URL: RU }), { username: 'u', chatId: 42 }))
      .rejects.toThrow('down');
  });

  it('keeps the payload scoped by audience + chat on every backend', async () => {
    const bodies = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, opts) => {
      bodies.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({ killed: 0 }) };
    }));
    await stopTask(env({ AGENT_RU_URL: RU }), { username: 'u', chatId: 42 });
    expect(bodies).toEqual([
      { username: 'u', chatId: 42, audience: 'recruiter' },
      { username: 'u', chatId: 42, audience: 'recruiter' },
    ]);
  });
});
