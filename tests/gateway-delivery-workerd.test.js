import { expect, it } from 'vitest';
import { buildSync } from 'esbuild';
import { Miniflare, createFetchMock } from 'miniflare';

it('POST /deliver persists a sent receipt and does not resend on a lost CP response', async () => {
  const code = buildSync({ entryPoints: ['src/index.js'], bundle: true, write: false,
    format: 'esm', platform: 'browser', external: ['node:buffer'] }).outputFiles[0].text;
  const fetchMock = createFetchMock();
  fetchMock.disableNetConnect();
  let providerCalls = 0;
  fetchMock.get('https://api.telegram.org')
    .intercept({ path: '/bot123:token/sendMessage', method: 'POST' })
    .reply(() => {
      providerCalls += 1;
      return { statusCode: 200, data: JSON.stringify({ ok: true, result: { message_id: 931 } }) };
    });
  const runtime = new Miniflare({ modules: true, script: code, compatibilityDate: '2024-01-01',
    compatibilityFlags: ['nodejs_compat'], fetchMock, bindings: {
      BOT_TOKEN: '123:token', BOT_USERNAME: 'super_personal_assistant_bot', AGENT_SECRET: 'secret',
      EXECUTION_BACKEND: 'control-plane', CONTROL_PLANE_URL: 'https://trained-assist-cp-production.skillset-apply.workers.dev',
      CONTROL_PLANE_PRINCIPAL: 'gateway', CONTROL_PLANE_PROFILE: 'trained-assist-production',
      CONTROL_PLANE_PRINCIPAL_SIGNATURE: 'signature', TG_SLICE_DELIVERY_PAUSED: 'false',
      TG_SLICE_ROUTER_ENABLED: 'true', TELEGRAM_API_BASE: 'https://api.telegram.org',
    }, durableObjects: { TG_DELIVERY_OWNER: { className: 'TgDeliveryOwner', useSQLite: true } },
  });
  try {
    const payload = { deliveryId: 'cp-delivery-1', userTaskId: 'ut-delivery-1',
      taskAcceptedAt: Date.now(), channel: 'telegram', destinationId: '1714048',
      message: { kind: 'stuck_input', text: 'waiting', actions: ['launch'] } };
    const request = () => runtime.dispatchFetch('https://worker.test/deliver', { method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const first = await request();
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ providerMessageId: 931, deliveryId: payload.deliveryId });

    // Simulate the CP losing the first HTTP response and retrying its stable outbox ID.
    const duplicate = await request();
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ providerMessageId: 931, duplicate: true });
    expect(providerCalls).toBe(1);
  } finally {
    await runtime.dispose();
    await fetchMock.close();
  }
}, 20000);

it('POST /deliver preserves an ambiguous provider outcome as unknown and never resends it', async () => {
  const code = buildSync({ entryPoints: ['src/index.js'], bundle: true, write: false,
    format: 'esm', platform: 'browser', external: ['node:buffer'] }).outputFiles[0].text;
  const fetchMock = createFetchMock();
  fetchMock.disableNetConnect();
  let providerCalls = 0;
  fetchMock.get('https://api.telegram.org')
    .intercept({ path: '/bot123:token/sendMessage', method: 'POST' })
    .reply(() => {
      providerCalls += 1;
      // Simulate a response lost or corrupted after the provider may have accepted it.
      return { statusCode: 200, data: 'provider response lost' };
    });
  const runtime = new Miniflare({ modules: true, script: code, compatibilityDate: '2024-01-01',
    compatibilityFlags: ['nodejs_compat'], fetchMock, bindings: {
      BOT_TOKEN: '123:token', BOT_USERNAME: 'super_personal_assistant_bot', AGENT_SECRET: 'secret',
      EXECUTION_BACKEND: 'control-plane', CONTROL_PLANE_URL: 'https://trained-assist-cp-production.skillset-apply.workers.dev',
      CONTROL_PLANE_PRINCIPAL: 'gateway', CONTROL_PLANE_PROFILE: 'trained-assist-production',
      CONTROL_PLANE_PRINCIPAL_SIGNATURE: 'signature', TG_SLICE_DELIVERY_PAUSED: 'false',
      TG_SLICE_ROUTER_ENABLED: 'true', TELEGRAM_API_BASE: 'https://api.telegram.org',
    }, durableObjects: { TG_DELIVERY_OWNER: { className: 'TgDeliveryOwner', useSQLite: true } },
  });
  try {
    const payload = { deliveryId: 'cp-delivery-unknown', userTaskId: 'ut-delivery-unknown',
      taskAcceptedAt: Date.now(), channel: 'telegram', destinationId: '1714048',
      message: { kind: 'stuck_input', text: 'waiting', actions: ['launch'] } };
    const request = () => runtime.dispatchFetch('https://worker.test/deliver', { method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const first = await request();
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ outcome: 'unknown', status: 'unknown', deliveryId: payload.deliveryId });

    const retry = await request();
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ outcome: 'unknown', status: 'unknown', deliveryId: payload.deliveryId });
    expect(providerCalls).toBe(1);
  } finally {
    await runtime.dispose();
    await fetchMock.close();
  }
}, 20000);

it('real gateway and SQLite owner deliver a complete long result in paragraph parts before acknowledging it', async () => {
  const code = buildSync({ entryPoints: ['src/index.js'], bundle: true, write: false,
    format: 'esm', platform: 'browser', external: ['node:buffer'] }).outputFiles[0].text;
  const fetchMock = createFetchMock();fetchMock.disableNetConnect();
  const messages = [];
  fetchMock.get('https://api.telegram.org').intercept({ path: '/bot123:token/sendMessage', method: 'POST' }).reply(options => {
    messages.push(new Response(options.body).text().then(raw => JSON.parse(raw).text));
    return { statusCode: 200, data: JSON.stringify({ ok: true, result: { message_id: 1000 + messages.length } }) };
  }).persist();
  const runtime = new Miniflare({ modules: true, script: code, compatibilityDate: '2024-01-01',
    compatibilityFlags: ['nodejs_compat'], fetchMock, bindings: {
      BOT_TOKEN: '123:token', BOT_USERNAME: 'super_personal_assistant_bot', AGENT_SECRET: 'secret',
      EXECUTION_BACKEND: 'control-plane', CONTROL_PLANE_URL: 'https://trained-assist-cp-production.skillset-apply.workers.dev',
      CONTROL_PLANE_PRINCIPAL: 'gateway', CONTROL_PLANE_PROFILE: 'trained-assist-production',
      CONTROL_PLANE_PRINCIPAL_SIGNATURE: 'signature', TG_SLICE_DELIVERY_PAUSED: 'false',
      TG_SLICE_ROUTER_ENABLED: 'true', TELEGRAM_API_BASE: 'https://api.telegram.org',
    }, durableObjects: { TG_DELIVERY_OWNER: { className: 'TgDeliveryOwner', useSQLite: true } },
  });
  try {
    const text = Array.from({ length: 5 }, (_, i) => `Section ${i + 1}: ${'Architecture requirement 🧪. '.repeat(40)}`).join('\n\n');
    expect(text.length).toBeGreaterThan(4096);
    const payload = { deliveryId: 'cp-complete-result', userTaskId: 'ut-complete-result', taskAcceptedAt: Date.now(),
      channel: 'telegram', destinationId: '1714048', message: { kind: 'result', text } };
    const request = () => runtime.dispatchFetch('https://worker.test/deliver', { method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const first = await request();const firstBody = await first.json();
    expect(firstBody).toMatchObject({ outcome: 'pending' });
    expect(first.status).toBe(503);
    let response;
    for (let i = 0; i < 10; i++) { response = await request();if (response.status === 200) break;expect(response.status).toBe(503); }
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ providerMessageId: 1001 });
    const delivered = await Promise.all(messages);
    expect(delivered.join('')).toBe(text);
    expect(delivered.every(part => part.length <= 2000)).toBe(true);
    const count = messages.length;
    expect((await request()).status).toBe(200);expect(messages).toHaveLength(count);
  } finally { await runtime.dispose();await fetchMock.close(); }
}, 20000);
