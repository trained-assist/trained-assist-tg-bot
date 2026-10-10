import { describe, expect, it } from 'vitest';
import { IntakeBufferReset } from '../src/sandbox-tg/existing-ux.js';

class Storage {
  constructor(entries = {}) { this.values = new Map(Object.entries(entries)); this.alarm = 1234; }
  async get(key) { return this.values.get(key); }
  async put(key, value) { this.values.set(key, value); }
  async delete(key) { this.values.delete(key); }
  async list({ prefix = '' } = {}) { return new Map([...this.values].filter(([key]) => key.startsWith(prefix))); }
  async getAlarm() { return this.alarm; }
  async deleteAlarm() { this.alarm = null; }
}

function actor(entries = {}) {
  const storage = new Storage(entries);
  const state = { storage, blockConcurrencyWhile: operation => operation() };
  const env = { TG_ACCEPT_ONLY_ENVIRONMENT: 'sandbox', TG_SANDBOX_BOT_USERNAME: 'probability_cat_bot',
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
    const { instance, storage } = actor({ launching: [{ text: 'request not yet admitted' }] });
    const clear = await instance.fetch(new Request('https://intake/operator/reset-all', { method: 'POST' }));
    expect(clear.status).toBe(409);
    expect(await clear.json()).toEqual({ error: 'active_intake_state' });
    expect((await storage.list()).size).toBe(1);
  });
});
