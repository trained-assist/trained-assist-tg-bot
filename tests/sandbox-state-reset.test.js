import { describe, expect, it } from 'vitest';
import { IntakeBuffer, IntakeBufferReset } from '../src/sandbox-tg/existing-ux.js';

class Storage {
  constructor(entries = {}) { this.values = new Map(Object.entries(entries)); this.alarm = 1234; }
  async get(key) { return this.values.get(key); }
  async put(key, value) { this.values.set(key, value); }
  async delete(key) { this.values.delete(key); }
  async list({ prefix = '', startAfter, limit = 1000 } = {}) {
    const entries = [...this.values].filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter)).sort(([a], [b]) => a.localeCompare(b));
    return new Map(entries.slice(0, limit));
  }
  async getAlarm() { return this.alarm; }
  async deleteAlarm() { this.alarm = null; }
}

function actor(entries = {}) {
  const storage = new Storage(entries);
  const state = { storage, blockConcurrencyWhile: operation => operation() };
  const env = { TG_ACCEPT_ONLY_ENVIRONMENT: 'sandbox', TG_SANDBOX_BOT_USERNAME: 'probability_cat_bot',
    CONTROL_PLANE_URL: 'https://trained-assist-cp-telegram-ux-v1-sandbox.skillset-apply.workers.dev',
    SESSION_NAMESPACE: 'integrator-existing-ux-v1', EXECUTION_BACKEND: 'control-plane', SESSIONS: {} };
  return { instance: new IntakeBufferReset(state, env), storage };
}

describe('sandbox-only Intake DO reset', () => {
  it('reports and refuses an in-progress launch but allows clearing stale busy and receipt markers', async () => {
    const { instance, storage } = actor({ buf: [{ text: 'old test input' }], busy: true,
      cpUnresolvedLaunches: ['old-request'], cpStopWindow: { pending: true }, alarm: 7 });
    const inspect = await instance.fetch(new Request('https://intake/operator/reset-inspect', { method: 'POST' }));
    expect(await inspect.json()).toMatchObject({ ok: true, active: false, keys: 5 });
    const clear = await instance.fetch(new Request('https://intake/operator/reset-all', { method: 'POST' }));
    expect(await clear.json()).toMatchObject({ ok: true, deletedKeys: 5 });
    expect((await storage.list()).size).toBe(0);
    expect(await storage.getAlarm()).toBeNull();
  });

  it('refuses to clear while a launch is still in progress', async () => {
    const { instance, storage } = actor({ launching: [{ text: 'request not yet admitted' }], busySince: Date.now() });
    const clear = await instance.fetch(new Request('https://intake/operator/reset-all', { method: 'POST' }));
    expect(clear.status).toBe(409);
    expect(await clear.json()).toEqual({ error: 'active_intake_state' });
    expect((await storage.list()).size).toBe(2);
  });

  it('lets the paired sandbox reset clear a launch checkpoint older than the CP safety window', async () => {
    const { instance, storage } = actor({ launching: [{ text: 'old sandbox launch' }], busySince: Date.now() - 16 * 60_000,
      cpUnresolvedLaunches: ['[113,114]'], 'cp-launch:[113,114]': { snapshotRequestId: 'old-request' }, alarm: 7 });
    const inspect = await instance.fetch(new Request('https://intake/operator/reset-inspect', { method: 'POST' }));
    expect(await inspect.json()).toMatchObject({ active: false, staleLaunching: true });
    const clear = await instance.fetch(new Request('https://intake/operator/reset-all', { method: 'POST' }));
    expect(await clear.json()).toMatchObject({ ok: true, staleLaunchingRecovered: true });
    expect((await storage.list()).size).toBe(0);
    expect(await storage.getAlarm()).toBeNull();
  });

  it('still refuses reset when a CP request is currently in flight, even with an old timestamp', async () => {
    const { instance, storage } = actor({ launching: [{ text: 'request still dispatching' }], busySince: Date.now() - 16 * 60_000 });
    instance.cpDispatches = 1;
    const inspect = await instance.fetch(new Request('https://intake/operator/reset-inspect', { method: 'POST' }));
    expect(await inspect.json()).toMatchObject({ active: true, staleLaunching: false });
    const clear = await instance.fetch(new Request('https://intake/operator/reset-all', { method: 'POST' }));
    expect(clear.status).toBe(409);
    expect((await storage.list()).size).toBe(2);
  });

  it('clears large Durable Object buffers in pages', async () => {
    const entries = Object.fromEntries(Array.from({ length: 1201 }, (_, index) => [`old:${String(index).padStart(4, '0')}`, index]));
    const { instance, storage } = actor(entries);
    const clear = await instance.fetch(new Request('https://intake/operator/reset-all', { method: 'POST' }));
    expect(await clear.json()).toMatchObject({ ok: true, deletedKeys: 1201 });
    expect((await storage.list()).size).toBe(0);
  });

  it('allows the existing sandbox3 IntakeBuffer class only for its exact CP identity', async () => {
    const storage = new Storage({ buf: [{ text: 'stale sandbox3 input' }] });
    const state = { storage, blockConcurrencyWhile: operation => operation() };
    const env = { TG_ACCEPT_ONLY_ENVIRONMENT: 'sandbox', TG_SANDBOX_BOT_USERNAME: 'ptichka_status_bot',
      CONTROL_PLANE_URL: 'https://trained-assist-cp-sandbox3.skillset-apply.workers.dev',
      CONTROL_PLANE_PROFILE: 'integration-sandbox3-v1', SESSION_NAMESPACE: 'integrator-sandbox3-v1',
      EXECUTION_BACKEND: 'control-plane' };
    const intake = new IntakeBuffer(state, env);
    const inspected = await intake.fetch(new Request('https://intake/operator/reset-inspect', { method: 'POST' }));
    expect(await inspected.json()).toMatchObject({ ok: true, active: false, keys: 1 });
    const reset = await intake.fetch(new Request('https://intake/operator/reset-all', { method: 'POST' }));
    expect(await reset.json()).toMatchObject({ ok: true, deletedKeys: 1 });
    expect((await storage.list()).size).toBe(0);

    const foreignEnv = { ...env, CONTROL_PLANE_URL: 'https://other-cp.invalid' };
    const foreign = new IntakeBuffer(state, foreignEnv);
    expect((await foreign.fetch(new Request('https://intake/operator/reset-inspect', { method: 'POST' }))).status).toBe(409);
  });
});
