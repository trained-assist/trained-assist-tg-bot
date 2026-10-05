import { expect, it } from 'vitest';
import { buildSync } from 'esbuild';
import { Miniflare, createFetchMock } from 'miniflare';
import { makeEnv } from './helpers/p11-helpers.js';

it('real local workerd SQLite owner commits once across concurrent durable-object requests', async () => {
  const code = buildSync({ entryPoints: ['src/sandbox-tg/index.js'], bundle: true, write: false, format: 'esm', platform: 'browser' }).outputFiles[0].text;
  const env = makeEnv();
  const fetchMock = createFetchMock();
  fetchMock.disableNetConnect();
  let providerCalls = 0;
  let providerEntered;
  const entered = new Promise(resolve => { providerEntered = resolve; });
  fetchMock.get(env.TELEGRAM_API_BASE).intercept({ path: `/bot${env.TG_SANDBOX_BOT_TOKEN}/sendMessage`, method: 'POST' }).reply(() => {
    providerCalls += 1;
    providerEntered();
    return { statusCode: 200, data: JSON.stringify({ ok: true, result: { message_id: 1365 } }) };
  }).delay(100);
  const runtime = new Miniflare({ modules: true, script: code, compatibilityDate: '2024-01-01',
    compatibilityFlags: ['nodejs_compat'], fetchMock, kvNamespaces: ['TG_SLICE'],
    bindings: Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === 'string')),
    durableObjects: { TG_DELIVERY_OWNER: { className: 'TgDeliveryOwner', useSQLite: true } },
  });
  try {
    const namespace = await runtime.getDurableObjectNamespace('TG_DELIVERY_OWNER');
    const stub = namespace.get(namespace.idFromName(`sandbox-delivery-v1:${env.TG_SANDBOX_BOT_USERNAME}`));
    const call = async (route, body = {}) => {
      const response = await stub.fetch(`https://delivery-owner.internal/${route}`, { method: 'POST', body: JSON.stringify(body) });
      expect(response.status).toBe(200);
      return response.json();
    };
    await call('open');
    await call('enqueue', { userTaskId: 'task', deliveryId: 'terminal:task:g1', destination: { chatId: 1001 }, type: 'message', text: 'synthetic', taskAcceptedAt: Date.now() });
    const first = call('drain');
    await Promise.race([entered, first.then(() => { throw new Error('mock provider was not observed'); })]);
    expect((await call('read', { taskId: 'task' })).terminal.status).toBe('sending');
    const results = await Promise.all([first, call('drain')]);
    expect(results.map(result => result.drained).sort()).toEqual([0, 1]);
    expect(providerCalls).toBe(1);
    expect((await call('read', { taskId: 'task' })).terminal).toMatchObject({ status: 'sent', providerMessageId: 1365, attempts: 1 });
    expect((await call('drain')).drained).toBe(0);
    expect(providerCalls).toBe(1);
  } finally { await runtime.dispose(); await fetchMock.close(); }
}, 20000);
