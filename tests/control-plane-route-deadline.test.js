import { afterEach, expect, it, vi } from 'vitest';
import { ControlPlaneClient } from '../src/sandbox-tg/control-plane-client.js';
import { readTgSliceConfig } from '../src/sandbox-tg/config.js';
import { makeEnv } from './helpers/p11-helpers.js';
afterEach(() => vi.restoreAllMocks());
it('waits for bounded classification on route while keeping normal reads on their fast deadline', async () => {
  const config = readTgSliceConfig(makeEnv({ TG_SLICE_REQUEST_TIMEOUT_MS: '1000' }));
  expect(config.routeRequestTimeoutMs).toBe(140000);
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => new AbortController().signal);
  const requests = [];
  const client = new ControlPlaneClient(config, { fetchImpl: async (url, init) => {
    requests.push({ url, init }); return Response.json({});
  } });
  await client.route('fixture-task');
  await client.request('GET', '/status', { query: { taskId: 'fixture-task' } });
  expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([140000, 1000]);
  expect(JSON.parse(requests[0].init.body)).toEqual({ taskId: 'fixture-task', continue: true });
  expect(requests[0].init.signal).toBeInstanceOf(AbortSignal);
});
it('allows a separately bounded route override', () => {
  expect(readTgSliceConfig(makeEnv({ TG_SLICE_ROUTE_REQUEST_TIMEOUT_MS: '150000' })).routeRequestTimeoutMs).toBe(150000);
  expect(() => readTgSliceConfig(makeEnv({ TG_SLICE_ROUTE_REQUEST_TIMEOUT_MS: '180001' }))).toThrow();
});
