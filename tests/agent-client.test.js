import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pickAgentUrl } from '../src/lib/agent-client.js';

const BASE = 'https://gcp.example.com';
const RU   = 'https://ru.example.com';
const USER = 'testuser';

function mockCapabilities(caps) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ capabilities: caps }),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pickAgentUrl', () => {
  it('returns AGENT_URL when AGENT_RU_URL not configured', async () => {
    const env = { AGENT_URL: BASE };
    expect(await pickAgentUrl(env, USER, 'nalog task')).toBe(BASE);
    expect(await pickAgentUrl(env, USER, 'nalog task', true)).toBe(BASE);
  });

  it('returns AGENT_URL for non-RU task when user has no RU capabilities', async () => {
    mockCapabilities([]);
    const env = { AGENT_URL: BASE, AGENT_RU_URL: RU, AGENT_SECRET: 'x' };
    expect(await pickAgentUrl(env, USER, 'write some code')).toBe(BASE);
  });

  it('returns AGENT_URL for RU-keyword task when user has no nalog token', async () => {
    mockCapabilities([]); // user has no RU-only services connected
    const env = { AGENT_URL: BASE, AGENT_RU_URL: RU, AGENT_SECRET: 'x' };
    expect(await pickAgentUrl(env, USER, 'проверь налоги')).toBe(BASE);
  });

  it('returns AGENT_RU_URL for nalog task when user has nalog capability', async () => {
    mockCapabilities(['nalog']);
    const env = { AGENT_URL: BASE, AGENT_RU_URL: RU, AGENT_SECRET: 'x' };
    expect(await pickAgentUrl(env, USER, 'проверь налоги')).toBe(RU);
    expect(await pickAgentUrl(env, USER, 'nalog.ru отчёт')).toBe(RU);
    expect(await pickAgentUrl(env, USER, 'чек нпд')).toBe(RU);
  });

  it('returns AGENT_RU_URL for forceRu=true without fetching capabilities', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const env = { AGENT_URL: BASE, AGENT_RU_URL: RU, AGENT_SECRET: 'x' };
    expect(await pickAgentUrl(env, USER, 'написать тест', true)).toBe(RU);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('falls back to AGENT_URL when capabilities endpoint is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
    const env = { AGENT_URL: BASE, AGENT_RU_URL: RU, AGENT_SECRET: 'x' };
    expect(await pickAgentUrl(env, USER, 'проверь налоги')).toBe(BASE);
  });

  it('handles STT dot-splitting: "na log.ru" routes to RU if user has nalog', async () => {
    mockCapabilities(['nalog']);
    const env = { AGENT_URL: BASE, AGENT_RU_URL: RU, AGENT_SECRET: 'x' };
    expect(await pickAgentUrl(env, USER, 'зайди на na log.ru')).toBe(RU);
  });
});

import { runTask } from '../src/lib/agent-client.js';
describe('intake delivery outcomes', () => {
  const env = { AGENT_URL: BASE, AGENT_SECRET: 'test' };
  const packet = { username: 'u', userId: 42, task: 'test', traceId: 'trace-1' };
  it('does not retry an ambiguous transport failure and supplies the lookup ID', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('timeout'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(runTask(env, packet)).rejects.toMatchObject({ delivery: 'unknown', taskId: 'u-intake-trace-1', agentUrl: BASE });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('does not retry 503 because a proxy may fail after admission', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(runTask(env, packet)).rejects.toMatchObject({ delivery: 'unknown' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('reports validation rejection so the original packet can be restored', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 400 })));
    await expect(runTask(env, packet)).rejects.toMatchObject({ delivery: 'rejected' });
  });
  it('treats an unreadable acknowledgement as ambiguous', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not json')));
    await expect(runTask(env, packet)).rejects.toMatchObject({ delivery: 'unknown' });
  });
});
