import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { TgDeliveryOwnerClient } from '../src/sandbox-tg/delivery-owner.js';
import { makeEnv, MemKV } from './helpers/p11-helpers.js';

it.each([307, 308])('real provider HTTP%s cannot replay POST or turn a redirected 429 into a retry', async status => {
  let initialPosts = 0;
  let forwardedPosts = 0;
  const server = createServer((request, response) => {
    if (request.url === '/forward') {
      if (request.method === 'POST') forwardedPosts += 1;
      response.writeHead(429, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 1 } }));
      return;
    }
    if (request.method === 'POST') initialPosts += 1;
    response.writeHead(status, { location: '/forward' });
    response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const env = makeEnv({ TG_SLICE: new MemKV(), TELEGRAM_API_BASE: `http://127.0.0.1:${server.address().port}` });
    const client = new TgDeliveryOwnerClient(env);
    await client.open();
    await client.enqueue({ deliveryId: 'terminal:redirect-task:g1', userTaskId: 'redirect-task',
      destination: { chatId: 1001 }, type: 'message', text: 'synthetic', taskAcceptedAt: Date.now() });
    expect(await client.drain()).toBe(1);
    const record = await client.load('terminal:redirect-task:g1');
    expect(record).toMatchObject({ status: 'unknown', reason: 'provider_outcome_unknown', attempts: 1 });
    expect(record.nextAttemptAt).toBeUndefined();
    expect((await client.read('redirect-task')).terminal.providerMessageId).toBeNull();
    expect(await client.drain()).toBe(0);
    expect(initialPosts).toBe(1);
    expect(forwardedPosts).toBe(0);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
