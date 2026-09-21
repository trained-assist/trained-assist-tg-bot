import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { classifyAgentError } from '../src/lib/agent-client.js';

// R10 invariant (spec §3, S9): a 15s sync-timeout on /run does NOT prove the
// agent is down. /run returns 202 immediately after enqueue (agent server.js),
// so a slow ack means the agent is BUSY (up to 6 concurrent tasks), not dead.
// Telling the user "недоступен, попробуй через минуту" is a false-negative that
// provokes a resend → duplicate session (the very class of bug the intake
// refactor exists to kill). classifyAgentError must probe /health on timeout
// and only report 'down' when the agent is genuinely unreachable.

const ENV = { AGENT_URL: 'https://agent.example.com', AGENT_SECRET: 'x' };

function stubHealth(ok) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok }));
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('classifyAgentError (R10 — busy is not down)', () => {
  it('502 → down (proxy/agent genuinely failing)', async () => {
    expect(await classifyAgentError(ENV, new Error('agent /run HTTP 502'))).toBe('down');
  });

  it('503 → down', async () => {
    expect(await classifyAgentError(ENV, new Error('agent /run HTTP 503'))).toBe('down');
  });

  it('TimeoutError + healthy agent → busy (NOT down)', async () => {
    stubHealth(true);
    const err = new Error('The operation timed out');
    err.name = 'TimeoutError';
    expect(await classifyAgentError(ENV, err)).toBe('busy');
  });

  it('TimeoutError + unreachable agent → down', async () => {
    stubHealth(false);
    const err = new Error('The operation timed out');
    err.name = 'TimeoutError';
    expect(await classifyAgentError(ENV, err)).toBe('down');
  });

  it('unknown error → error (surface the real message, do not mislabel)', async () => {
    expect(await classifyAgentError(ENV, new Error('boom'))).toBe('error');
  });
});
