import { it, expect, vi } from 'vitest';
import worker from '../src/index.js';

// Epic #1527 PR1: the agent's run-finished push releases the chat's IntakeBuffer
// `busy` hold. The route used to reject chatId <= 0 — but Telegram group ids are
// NEGATIVE, so every group run's release was dropped and «▶️ Запустить проработку»
// stayed dead for BUSY_MAX_MS (#1534 regression).
function makeEnv() {
  const stub = { fetch: vi.fn(async () => Response.json({ released: true })) };
  return {
    env: { AGENT_SECRET: 'test-secret', INTAKE: { idFromName: vi.fn(x => x), get: vi.fn(() => stub) } },
    stub,
  };
}

function req(body, token = 'test-secret') {
  return new Request('https://worker/internal/run-finished', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: JSON.stringify(body),
  });
}

it('requires the configured agent secret', async () => {
  const { env, stub } = makeEnv();
  expect((await worker.fetch(req({ chatId: -5578467476 }, null), env)).status).toBe(401);
  expect((await worker.fetch(req({ chatId: -5578467476 }, 'wrong'), env)).status).toBe(401);
  expect(stub.fetch).not.toHaveBeenCalled();
});

it('rejects only the 0 sentinel / non-integer chatId', async () => {
  const { env, stub } = makeEnv();
  expect((await worker.fetch(req({ chatId: 0 }), env)).status).toBe(400);
  expect((await worker.fetch(req({}), env)).status).toBe(400);
  expect((await worker.fetch(req({ chatId: 'nope' }), env)).status).toBe(400);
  expect(stub.fetch).not.toHaveBeenCalled();
});

it('forwards a NEGATIVE group chatId to its IntakeBuffer', async () => {
  const { env, stub } = makeEnv();
  const res = await worker.fetch(req({ chatId: -5578467476, requestId: 'intake-abc' }), env);
  expect(res.status).toBe(200);
  expect(env.INTAKE.idFromName).toHaveBeenCalledWith('-5578467476');
  expect(stub.fetch).toHaveBeenCalledWith('https://intake/run-finished', {
    method: 'POST',
    body: JSON.stringify({ requestId: 'intake-abc' }),
  });
});
