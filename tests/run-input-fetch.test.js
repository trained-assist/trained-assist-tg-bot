import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchRunInput } from '../src/lib/agent-client.js';

afterEach(() => vi.unstubAllGlobals());

describe('fetchRunInput — «Посмотреть инпут» asks the agent for the REAL model input', () => {
  it('derives the taskId, calls the routed agent with Bearer auth, returns the document', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('REAL DOC', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const env = { AGENT_URL: 'https://gcp', AGENT_RU_URL: null, AGENT_SECRET: 's3c' };
    const out = await fetchRunInput(env, { username: 'vova', audience: 'default', requestId: 'msg-9-1', task: 'привет' });
    expect(out).toBe('REAL DOC');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gcp/internal/run-input?username=vova&taskId=vova-msg-9-1');
    expect(opts.headers.Authorization).toBe('Bearer s3c');
  });

  it('404 (run predates the feature) → null, caller falls back to the snapshot view', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not found', { status: 404 })));
    const env = { AGENT_URL: 'https://gcp', AGENT_SECRET: 's3c' };
    await expect(fetchRunInput(env, { username: 'vova', requestId: 'msg-9-1' })).resolves.toBeNull();
  });

  it('no requestId in the snapshot → no request at all, null', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const env = { AGENT_URL: 'https://gcp', AGENT_SECRET: 's3c' };
    await expect(fetchRunInput(env, { username: 'vova' })).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('network failure never throws — returns null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));
    const env = { AGENT_URL: 'https://gcp', AGENT_SECRET: 's3c' };
    await expect(fetchRunInput(env, { username: 'vova', requestId: 'msg-9-1' })).resolves.toBeNull();
  });
});
