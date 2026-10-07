import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/staging-agent/index.js';

const env = {
  AGENT_SECRET: 'staging-only-secret',
  GATEWAY_URL: 'https://gateway.staging.test',
  TEST_USERNAME: 'tgpatrol_20261007_v1',
};

function request(path, { method = 'GET', body, secret = env.AGENT_SECRET } = {}) {
  return new Request(`https://test-agent${path}`, {
    method,
    headers: {
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

afterEach(() => vi.restoreAllMocks());

describe('isolated staging test agent', () => {
  it('reports that it has no tools and rejects unauthenticated API calls', async () => {
    const health = await worker.fetch(request('/health'), env);
    expect(await health.json()).toEqual({ status: 'alive', mode: 'test-only', toolsEnabled: false });
    const projects = await worker.fetch(request('/projects', { secret: '' }), env);
    expect(projects.status).toBe(401);
  });

  it('accepts the explicit local test secret binding without weakening auth', async () => {
    const localEnv = { ...env, AGENT_SECRET: '', TEST_AGENT_SECRET: 'local-test-secret' };
    const allowed = await worker.fetch(request('/project-decision?username=tgpatrol_20261007_v1', { secret: 'local-test-secret' }), localEnv);
    expect(allowed.status).toBe(200);
    const denied = await worker.fetch(request('/project-decision?username=tgpatrol_20261007_v1', { secret: 'wrong' }), localEnv);
    expect(denied.status).toBe(401);
  });

  it('offers only the synthetic staging user the quick path', async () => {
    const allowed = await worker.fetch(request('/project-decision?username=tgpatrol_20261007_v1'), env);
    expect(await allowed.json()).toEqual({ action: 'quick', choices: [] });
    const denied = await worker.fetch(request('/project-decision?username=someone-else'), env);
    expect(denied.status).toBe(403);
  });

  it('clears intake only for the configured synthetic user and chat', async () => {
    const gateEnv = { ...env, TEST_CHAT_IDS: '24790956' };
    const allowed = await worker.fetch(request('/intake-gate', {
      method: 'POST',
      body: { username: env.TEST_USERNAME, chatId: 24790956, text: 'safe staging task' },
    }), gateEnv);
    expect(await allowed.json()).toEqual({ level: 'clear', delayMs: 1000, announce: null });
    const denied = await worker.fetch(request('/intake-gate', {
      method: 'POST',
      body: { username: env.TEST_USERNAME, chatId: 12345, text: 'safe staging task' },
    }), gateEnv);
    expect(denied.status).toBe(403);
    const unauthorized = await worker.fetch(request('/intake-gate', {
      method: 'POST', secret: '',
      body: { username: env.TEST_USERNAME, chatId: 24790956, text: 'safe staging task' },
    }), gateEnv);
    expect(unauthorized.status).toBe(401);
  });

  it('rejects runs that are not log-only synthetic chats', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const response = await worker.fetch(request('/run', {
      method: 'POST',
      body: {
        username: env.TEST_USERNAME,
        chatId: 12345,
        userId: 12345,
        delivery: 'send',
        requestId: 'test-1',
        task: 'hello',
      },
    }), env);
    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('completes a harmless log-only run through the existing gateway callback', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ok: true }));
    const response = await worker.fetch(request('/run', {
      method: 'POST',
      body: {
        username: env.TEST_USERNAME,
        chatId: -100000000000000,
        userId: -100000000000000,
        delivery: 'log',
        requestId: 'test-run-1',
        task: 'работает?',
      },
    }), env);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ durable: true, requestId: 'test-run-1' });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`${env.GATEWAY_URL}/internal/run-finished`);
    expect(init.headers.Authorization).toBe(`Bearer ${env.AGENT_SECRET}`);
    expect(JSON.parse(init.body)).toMatchObject({
      chatId: -100000000000000,
      requestId: 'test-run-1',
      outcome: 'quick',
      answer: 'Да, тестовый агент отвечает. Внешние инструменты отключены.',
    });
  });

  it('uses the staging gateway service binding for run-finished callbacks', async () => {
    const gatewayFetch = vi.fn().mockResolvedValue(Response.json({ busy: false }));
    const networkFetch = vi.spyOn(globalThis, 'fetch');
    const response = await worker.fetch(request('/run', {
      method: 'POST',
      body: {
        username: env.TEST_USERNAME,
        chatId: -100000000000000,
        userId: -100000000000000,
        delivery: 'log',
        requestId: 'service-binding-run',
        task: 'safe staging task',
      },
    }), { ...env, GATEWAY: { fetch: gatewayFetch } });
    expect(response.status).toBe(202);
    expect(gatewayFetch).toHaveBeenCalledTimes(1);
    const [callback] = gatewayFetch.mock.calls[0];
    expect(new URL(callback.url).pathname).toBe('/internal/run-finished');
    expect(callback.headers.get('Authorization')).toBe(`Bearer ${env.AGENT_SECRET}`);
    expect(networkFetch).not.toHaveBeenCalled();
  });

  it('does not expose or implement tool routes', async () => {
    const response = await worker.fetch(request('/tools/list'), env);
    expect(response.status).toBe(404);
  });
});
