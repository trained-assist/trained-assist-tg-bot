import { it, expect, vi } from 'vitest';
import worker from '../src/index.js';
it('archive restoration requires configured agent auth and targets only the selected chat', async () => {
 const stub = { fetch: vi.fn(async () => Response.json({ restored: true })) };
 const env = { AGENT_SECRET: 'test-secret', INTAKE: { idFromName: vi.fn(x => x), get: vi.fn(() => stub) } };
 const request = token => new Request('https://worker/debug/intake/42/restore', {
   method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: JSON.stringify({ id: 'a'.repeat(36) }),
 });
 expect((await worker.fetch(request(), env)).status).toBe(401);
 expect((await worker.fetch(request('wrong'), env)).status).toBe(401);
 expect((await worker.fetch(request('undefined'), { ...env, AGENT_SECRET: undefined })).status).toBe(401);
 expect(stub.fetch).not.toHaveBeenCalled();
 expect((await worker.fetch(request('test-secret'), env)).status).toBe(200);
 expect(env.INTAKE.idFromName).toHaveBeenCalledWith('42');
 expect(stub.fetch).toHaveBeenCalledWith('https://intake/restore', { method: 'POST', body: JSON.stringify({ id: 'a'.repeat(36) }) });
});
