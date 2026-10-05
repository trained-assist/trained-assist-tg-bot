import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/sandbox-tg/index.js';
import { TgDeliveryOwner, TgDeliveryOwnerClient } from '../src/sandbox-tg/delivery-owner.js';
import { makeEnv, MemKV, ownerState } from './helpers/p11-helpers.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

async function fixture(counts = [40, 3]) {
  const env = makeEnv({ TG_SLICE: new MemKV({ pageSize: 1 }) });
  const client = new TgDeliveryOwnerClient(env);
  await client.open();
  for (let conversation = 0; conversation < counts.length; conversation += 1) {
    await env.TG_SLICE.put(`conv:bounded-${conversation}`, JSON.stringify({
      conversationId: `bounded-${conversation}`, profileId: env.CONTROL_PLANE_PROFILE,
      destination: { chatId: 1001 }, requestingBot: env.TG_SANDBOX_BOT_USERNAME,
      turns: Array.from({ length: counts[conversation] }, (_, turn) => ({
        kind: 'new', userTaskId: `bounded-${conversation}-${turn}`, providerAcceptedAt: Date.now(),
      })), cursors: {},
    }));
  }
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const statuses = [];
  const provider = vi.fn(async () => Response.json({ ok: true, result: { message_id: 3000 + provider.mock.calls.length } }));
  vi.stubGlobal('fetch', async (input, init) => {
    const url = new URL(input);
    if (url.origin === env.TELEGRAM_API_BASE) return provider(input, init);
    if (url.pathname !== '/status') throw new Error('Journal pagination or mutation forbidden');
    const { taskId } = JSON.parse(init.body);
    statuses.push(taskId);
    return Response.json({ taskStore: { id: taskId, status: 'done', generation: 1, result: { answer: 'bounded answer' },
      history: Array.from({ length: 500 }, (_, sequence) => ({ sequence })) }, runs: [] });
  });
  return { env, client, provider, statuses };
}

describe('bounded autonomous delivery discovery', () => {
  it('drains queued records before large finite history discovery and never requests event pages', async () => {
    const { env, client, provider, statuses } = await fixture([1000]);
    const source = await env.TG_SLICE.get('conv:bounded-0');
    await client.enqueue({ deliveryId: 'receipt:already-queued', userTaskId: 'already-queued',
      taskAcceptedAt: Date.now(), destination: { chatId: 1001 }, type: 'message', text: 'queued' });
    const order = [];
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', async (input, init) => {
      order.push(new URL(input).origin === env.TELEGRAM_API_BASE ? 'provider' : 'status');
      return original(input, init);
    });
    await worker.scheduled({ cron: '* * * * *' }, env);
    expect(order[0]).toBe('provider');
    expect(provider).toHaveBeenCalledTimes(1);
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.length).toBeLessThanOrEqual(16);
    expect(await env.TG_SLICE.get('conv:bounded-0')).toBe(source);
    expect(await client.load('receipt:already-queued')).toMatchObject({ status: 'sent', attempts: 1 });
  });

  it('queued delivery progresses even when status never resolves and discovery expires', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const { env, client, provider } = await fixture([1, 1]);
    await client.enqueue({ deliveryId: 'receipt:slow', userTaskId: 'slow', taskAcceptedAt: Date.now(),
      destination: { chatId: 1001 }, type: 'message', text: 'queued' });
    const original = globalThis.fetch;
    let statusEntered;
    const entered = new Promise(resolve => { statusEntered = resolve; });
    vi.stubGlobal('fetch', (input, init) => {
      if (new URL(input).pathname === '/status') { statusEntered(); return new Promise(() => {}); }
      return original(input, init);
    });
    const tick = worker.scheduled({ cron: '* * * * *' }, env);
    await entered;
    expect(provider).toHaveBeenCalledTimes(1);
    expect(await client.load('receipt:slow')).toMatchObject({ status: 'sent', attempts: 1 });
    await vi.advanceTimersByTimeAsync(10001);
    await tick;
    expect(await client.discovery()).toMatchObject({ conversationKey: null, pageCursor: '1' });
    vi.stubGlobal('fetch', original);
    await worker.scheduled({}, env);
    expect(await client.load('terminal:bounded-1-0:g1')).not.toBeNull();
  });

  it('durable per-turn round robin resumes after owner restart without truncating history', async () => {
    const { env, client, statuses } = await fixture();
    const original = await env.TG_SLICE.get('conv:bounded-0');
    await worker.scheduled({}, env);
    const checkpoint = await client.discovery();
    const name = env.TG_DELIVERY_OWNER.idFromName(`sandbox-delivery-v1:${env.TG_SANDBOX_BOT_USERNAME}`);
    const storage = env.TG_DELIVERY_OWNER.owners.get(name).state.storage;
    const offset = await storage.get('discovery-turn:conv:bounded-0');
    expect(offset).toBeGreaterThan(0);
    expect(statuses).toContain('bounded-1-0');
    env.TG_DELIVERY_OWNER.owners.set(name, new TgDeliveryOwner(ownerState(storage), env));
    expect(await new TgDeliveryOwnerClient(env).discovery()).toEqual(checkpoint);
    expect(await storage.get('discovery-turn:conv:bounded-0')).toBe(offset);
    for (let tick = 0; tick < 11; tick += 1) await worker.scheduled({}, env);
    for (let turn = 0; turn < 40; turn += 1) expect(statuses).toContain(`bounded-0-${turn}`);
    for (let turn = 0; turn < 3; turn += 1) expect(statuses).toContain(`bounded-1-${turn}`);
    expect(await env.TG_SLICE.get('conv:bounded-0')).toBe(original);
    expect(await client.load('terminal:bounded-1-2:g1')).not.toBeNull();
    expect(await client.advanceDiscovery(checkpoint.revision, {
      pageCursor: null, conversationKey: null, nextPageCursor: null, turnIndex: 0,
    })).toBe(false);
  });

  it('holds ambiguous provider outcomes across bounded backlog discovery', async () => {
    const { env, client } = await fixture([100]);
    await client.enqueue({ deliveryId: 'terminal:ambiguous:g1', userTaskId: 'ambiguous', taskAcceptedAt: Date.now(),
      destination: { chatId: 1001 }, type: 'message', text: 'unknown' });
    const original = globalThis.fetch;
    let unknownCalls = 0;
    vi.stubGlobal('fetch', (input, init) => {
      if (new URL(input).origin === env.TELEGRAM_API_BASE && JSON.parse(init.body).text === 'unknown') {
        unknownCalls += 1;
        return Response.json({ ok: false }, { status: 500 });
      }
      return original(input, init);
    });
    await worker.scheduled({}, env);
    const evidence = await client.load('terminal:ambiguous:g1');
    for (let tick = 0; tick < 4; tick += 1) await worker.scheduled({}, env);
    expect(unknownCalls).toBe(1);
    expect(evidence).toMatchObject({ status: 'unknown', attempts: 1 });
    expect(await client.load('terminal:ambiguous:g1')).toEqual(evidence);
  });
});
