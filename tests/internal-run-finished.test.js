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

it('forwards consumed message ids (live inbox) to the IntakeBuffer', async () => {
  const { env, stub } = makeEnv();
  await worker.fetch(req({ chatId: 42, requestId: 'r1', consumed: [501, '502', 'x'] }), env);
  expect(stub.fetch).toHaveBeenCalledWith('https://intake/run-finished', {
    method: 'POST',
    body: JSON.stringify({ requestId: 'r1', consumed: [501, 502] }),
  });
});

const heldReq = (qs, token = 'test-secret') => new Request(`https://worker/internal/held-messages?${qs}`, {
  headers: token ? { Authorization: `Bearer ${token}` } : {},
});

it('held-messages: auth + chat validation, then reads the right IntakeBuffer', async () => {
  const { env, stub } = makeEnv();
  stub.fetch.mockResolvedValue(Response.json({ busy: true, items: [{ message_id: 7, text: 'hi' }] }));
  expect((await worker.fetch(heldReq('chatId=42', null), env)).status).toBe(401);
  expect((await worker.fetch(heldReq('chatId=0'), env)).status).toBe(400);
  expect((await worker.fetch(heldReq('chatId=42&threadId=-3'), env)).status).toBe(400);
  expect(stub.fetch).not.toHaveBeenCalled();
  const res = await worker.fetch(heldReq('chatId=-100123&threadId=9&requestId=intake-abc'), env);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ busy: true, items: [{ message_id: 7, text: 'hi' }] });
  expect(env.INTAKE.idFromName).toHaveBeenCalledWith(expect.stringContaining('-100123'));
  expect(stub.fetch).toHaveBeenCalledWith('https://intake/held?requestId=intake-abc');
});
