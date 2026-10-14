import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.js';
import { TgDeliveryOwnerClient } from '../src/sandbox-tg/delivery-owner.js';
import { makeEnv } from './helpers/p11-helpers.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const envWithAuth = overrides => makeEnv({
  AGENT_SECRET: 'test-secret',
  BOT_USERNAME: 'super_personal_assistant_bot',
  BUILD_SHA: 'e43feed',
  ...overrides,
});

const seededEnv = async (overrides = {}) => {
  const env = envWithAuth(overrides);
  const client = new TgDeliveryOwnerClient(env);
  await client.open();
  await client.enqueue({ deliveryId: 'terminal:task-a:g2', userTaskId: 'task-a', conversationId: 'conv-a',
    destination: { chatId: 1001, threadId: null }, type: 'message', text: 'agent answer A', taskAcceptedAt: Date.now() });
  await client.enqueue({ deliveryId: 'terminal:task-b:g1', userTaskId: 'task-b', conversationId: 'conv-b',
    destination: { chatId: 1002, threadId: null }, type: 'message', text: 'agent answer B', taskAcceptedAt: Date.now() });
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = new URL(input);
    if (url.pathname.endsWith('/sendMessage')) return Response.json({ ok: true, result: { message_id: 4242 } });
    throw new Error(`unexpected_request ${url.pathname}`);
  }));
  await client.drain();
  return { env, client };
};

describe('delivery-owner /list-deliveries', () => {
  it('lists only the requested chat, newest first, with provider outcome and without message text', async () => {
    const { client } = await seededEnv();
    const { deliveries } = await client.list(1001);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      deliveryId: 'terminal:task-a:g2', userTaskId: 'task-a', status: 'sent',
      providerMessageId: 4242, chatId: 1001, type: 'message', generation: 2,
    });
    expect(deliveries[0]).toHaveProperty('createdAt');
    expect(deliveries[0]).toHaveProperty('sentAt');
    expect(deliveries[0]).not.toHaveProperty('text');
    const other = await client.list(1002);
    expect(other.deliveries).toMatchObject([{ userTaskId: 'task-b', chatId: 1002 }]);
  });

  it('refuses to list chats outside the configured allowlist', async () => {
    const { client } = await seededEnv();
    await expect(client.list(999)).rejects.toThrow('delivery_owner_refused');
  });

  it('honours an explicit limit capped at 100', async () => {
    const { client } = await seededEnv();
    const { deliveries } = await client.list(1001, { limit: 100 });
    expect(deliveries).toHaveLength(1);
    await expect(client.list(1001, { limit: 0 })).resolves.toMatchObject({ deliveries: expect.any(Array) });
  });
});

describe('GET /debug/deliveries', () => {
  it('requires the agent secret and a well-formed chatId', async () => {
    const { env } = await seededEnv();
    const request = (query, headers = {}) => new Request(`https://worker/debug/deliveries${query}`, { headers });
    expect((await worker.fetch(request('?chatId=1001'), env)).status).toBe(401);
    expect((await worker.fetch(request('?chatId=1001', { Authorization: 'Bearer wrong' }), env)).status).toBe(401);
    expect((await worker.fetch(request('?chatId=1001', { Authorization: 'Bearer undefined' }), { ...env, AGENT_SECRET: undefined })).status).toBe(401);
    expect((await worker.fetch(request('?chatId=abc', { Authorization: 'Bearer test-secret' }), env)).status).toBe(400);
    expect((await worker.fetch(request('?chatId=1001&limit=0', { Authorization: 'Bearer test-secret' }), env)).status).toBe(400);
  });

  it('returns bot identity, buildSha and the chat delivery records', async () => {
    const { env } = await seededEnv();
    const res = await worker.fetch(new Request('https://worker/debug/deliveries?chatId=1001', {
      headers: { Authorization: 'Bearer test-secret' },
    }), env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ botUsername: 'super_personal_assistant_bot', buildSha: 'e43feed' });
    expect(body.deliveries).toMatchObject([{ deliveryId: 'terminal:task-a:g2', status: 'sent', providerMessageId: 4242 }]);
    expect(JSON.stringify(body)).not.toContain('agent answer');
  });

  it('maps a broken delivery-owner binding to 503 instead of a crash', async () => {
    const env = envWithAuth({ TG_DELIVERY_OWNER_V2: null });
    delete env.TG_DELIVERY_OWNER;
    const res = await worker.fetch(new Request('https://worker/debug/deliveries?chatId=1001', {
      headers: { Authorization: 'Bearer test-secret' },
    }), env);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('delivery_owner_unavailable');
  });
});
