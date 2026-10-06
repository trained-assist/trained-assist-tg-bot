import { describe, it, expect } from 'vitest';
import { runControlPlaneTask } from '../src/lib/control-plane-execution.js';
import { FakeControlPlane } from '../src/sandbox-tg/fake-control-plane.js';
import { makeEnv, MemKV } from './helpers/p11-helpers.js';

function fixture() {
  const calls = [];
  const snapshots = new Map();
  const receipts = new Map();
  const fake = new FakeControlPlane();
  let routeFails = false;
  const env = makeEnv({ TG_SLICE: new MemKV(), CONTROL_PLANE_SESSION_ID: 'source-session' });
  const stub = { async fetch(url, options = {}) {
    const address = new URL(url);
    if (address.pathname === '/snapshot') {
      const value = JSON.parse(options.body);
      if (!snapshots.has(value.body.requestId)) snapshots.set(value.body.requestId, value);
      return Response.json(snapshots.get(value.body.requestId));
    }
    if (address.pathname === '/cp-acceptance') {
      if (options.method === 'POST') {
        const value = JSON.parse(options.body);
        receipts.set(value.requestId, value.receipt);
        return Response.json({ ok: true });
      }
      return Response.json({ receipt: receipts.get(address.searchParams.get('requestId')) ?? null });
    }
    throw new Error('unexpected collector endpoint');
  } };
  env.INTAKE = { idFromName: name => name, get: () => stub };
  env.CONTROL_PLANE_SERVICE = { async fetch(url, options) {
    const pathname = new URL(url).pathname;
    const body = JSON.parse(options.body);
    calls.push({ pathname, body });
    if (pathname === '/route' && routeFails) throw new Error('route acknowledgement unknown');
    const result = await fake.fetch(url, options);
    return Response.json(result.value, { status: result.status });
  } };
  const input = { userId: 1001, username: 'integrator', requestId: 'batch-1', sessionId: 'dialog-1',
    task: '[Сообщение 1]\nработает?\n\n[Сообщение 2]\nпосчитай расходы', initialMsgId: 123,
    inputItems: [{ msg: { text: 'работает?', message_id: 11 } }, { msg: { text: 'посчитай расходы', message_id: 12 } }] };
  return { env, input, calls, snapshots, receipts, fake, failRoute: value => { routeFails = value; } };
}

describe('existing collector control-plane execution boundary', () => {
  it('routes the entire ordered aggregate without starting an executor directly', async () => {
    const state = fixture();
    const ack = await runControlPlaneTask(state.env, state.input);
    expect(state.calls.map(call => call.pathname)).toEqual(['/intake', '/route']);
    expect(state.calls[0].body.inputItems).toEqual([{ text: 'работает?', artifactRefs: [] }, { text: 'посчитай расходы', artifactRefs: [] }]);
    expect(ack).toMatchObject({ durable: true, controlPlane: true, routingPending: false });
    expect(ack.taskId).toBe(ack.userTaskId);
    expect(state.fake.routes).toMatchObject([{ taskId: ack.userTaskId, route: 'agent', continuation: { requested: true, issued: false } }]);
    expect(state.fake.runs(ack.userTaskId)).toHaveLength(0);
  });

  it('reuses frozen input and source session after a cold adapter restart', async () => {
    const state = fixture();
    const first = await runControlPlaneTask(state.env, state.input);
    state.env.CONTROL_PLANE_SESSION_ID = 'changed-source-session';
    const second = await runControlPlaneTask(state.env, { ...state.input, task: 'changed', inputItems: [{ msg: { text: 'changed' } }] });
    expect(second.taskId).toBe(first.taskId);
    expect(state.calls.filter(call => call.pathname === '/intake')).toHaveLength(1);
    const body = [...state.snapshots.values()][0].body;
    expect(body.controlPlaneEnvelope.sessionId).toBe('source-session');
    expect(body.controlPlaneEnvelope.inputItems[0].text).toBe('работает?');
  });

  it('keeps durable task identity when route acknowledgement is lost', async () => {
    const state = fixture();
    state.failRoute(true);
    const first = await runControlPlaneTask(state.env, state.input);
    expect(first.routingPending).toBe(true);
    expect(state.receipts.size).toBe(1);
    state.failRoute(false);
    const recovered = await runControlPlaneTask(state.env, state.input);
    expect(recovered.taskId).toBe(first.taskId);
    expect(recovered.routingPending).toBe(false);
    expect(state.calls.filter(call => call.pathname === '/intake')).toHaveLength(1);
  });

  it('does not collide across topic or later equal-sized batch', async () => {
    const state = fixture();
    const first = await runControlPlaneTask(state.env, state.input);
    const next = await runControlPlaneTask(state.env, { ...state.input, requestId: 'batch-2' });
    const topic = await runControlPlaneTask(state.env, { ...state.input, threadId: 99 });
    expect(new Set([first.requestId, next.requestId, topic.requestId]).size).toBe(3);
  });

  it('blocks media instead of dispatching only its text caption', async () => {
    const state = fixture();
    await expect(runControlPlaneTask(state.env, { ...state.input,
      inputItems: [{ msg: { caption: 'analyse', document: { file_id: 'unmaterialized' } } }] })).rejects.toThrow('Вложения');
    expect(state.calls).toEqual([]);
  });

  it('fails closed for another profile or chat', async () => {
    const state = fixture();
    await expect(runControlPlaneTask(state.env, { ...state.input, userId: 9999 })).rejects.toThrow('chat_refused');
    state.env.TG_SLICE_CHAT_PROFILES = '1001:foreign-profile';
    await expect(runControlPlaneTask(state.env, state.input)).rejects.toThrow('profile_refused');
    expect(state.calls).toEqual([]);
  });
});
