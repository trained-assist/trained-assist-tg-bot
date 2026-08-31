import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pickAgentUrl } from '../src/lib/agent-client.js';

const BASE = 'https://gcp.example.com';
const RU   = 'https://ru.example.com';
const USER = 42;

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
