import { describe, it, expect } from 'vitest';
import { needsRuAgent, pickAgentUrl } from '../src/lib/agent-client.js';

describe('needsRuAgent', () => {
  it.each([
    ['налог'],
    ['nalog'],
    ['госуслуги'],
    ['тинькофф'],
    ['NALOG'],
    ['на nalog.ru'],
    ['проверь мои доходы на nalog.ru'],
    ['fns.ru'],
    ['sberbank'],
    ['сбер'],
  ])('returns true for RU keyword: %s', (task) => {
    expect(needsRuAgent(task)).toBe(true);
  });

  it.each([
    ['hello world'],
    ['github'],
    ['обычная задача'],
    ['напиши код'],
    ['что такое typescript'],
  ])('returns false for non-RU task: %s', (task) => {
    expect(needsRuAgent(task)).toBe(false);
  });
});

describe('pickAgentUrl', () => {
  const BASE = 'https://gcp.example.com';
  const RU   = 'https://ru.example.com';

  it('returns AGENT_URL when no AGENT_RU_URL configured', () => {
    const env = { AGENT_URL: BASE };
    expect(pickAgentUrl(env, 'nalog task')).toBe(BASE);
    expect(pickAgentUrl(env, 'nalog task', true)).toBe(BASE);
  });

  it('returns AGENT_URL for non-RU task', () => {
    const env = { AGENT_URL: BASE, AGENT_RU_URL: RU };
    expect(pickAgentUrl(env, 'write some code')).toBe(BASE);
  });

  it('returns AGENT_RU_URL for RU keyword in task', () => {
    const env = { AGENT_URL: BASE, AGENT_RU_URL: RU };
    expect(pickAgentUrl(env, 'проверь налоги')).toBe(RU);
  });

  it('returns AGENT_RU_URL when forceRu=true regardless of task', () => {
    const env = { AGENT_URL: BASE, AGENT_RU_URL: RU };
    expect(pickAgentUrl(env, 'написать тест', true)).toBe(RU);
  });
});
