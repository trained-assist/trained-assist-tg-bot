import { it, expect, vi } from 'vitest';
import worker from '../src/index.js';
it('preview serves exact revision and rejects ingress without touching storage or network', async () => {
  const touched = vi.fn(() => { throw Error('preview touched resources'); });
  const env = { PREVIEW_ONLY: 'true', BUILD_SHA: 'exact-revision', SESSIONS: { get: touched, put: touched } };
  const ctx = { waitUntil: touched };
  const health = await worker.fetch(new Request('https://preview/health'), env, ctx);
  expect(await health.json()).toMatchObject({ buildSha: 'exact-revision' });
  for (const [route, options] of [
    ['/webhook', { method: 'POST', body: '{}' }],
    ['/internal/media?username=alice&id=secret-file', { method: 'GET' }],
  ]) {
    const response = await worker.fetch(new Request('https://preview'+route, options), env, ctx);
    expect(response.status).toBe(403);
  }
  await worker.scheduled({}, env, ctx);
  expect(touched).not.toHaveBeenCalled();
});
