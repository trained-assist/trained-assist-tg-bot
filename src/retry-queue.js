import { processDueRetries } from './handlers/message.js';
import { scheduleRetry, takeDueRetries } from './lib/kv.js';

// One durable coordinator per worker: strongly consistent queue and serialized
// draining. KV read/delete is not a lock, even within overlapping cron invocations.
export class RetryQueue {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.tail = Promise.resolve();
    this.store = {
      put: (key, value, options = {}) => state.storage.put(key, {
        value, metadata: options.metadata,
        expiresAt: options.expirationTtl ? Date.now() + options.expirationTtl * 1000 : null,
      }),
      get: async key => (await state.storage.get(key))?.value ?? null,
      delete: key => state.storage.delete(key),
      list: async ({ prefix }) => {
        const rows = await state.storage.list({ prefix });
        return { keys: [...rows].map(([name, row]) => ({ name, metadata: row.metadata })), list_complete: true };
      },
    };
  }
  fetch(request) {
    const operation = this.tail.catch(() => {}).then(async () => {
      const path = new URL(request.url).pathname;
      if (path === '/enqueue') {
        const key = await scheduleRetry(this.store, await request.json());
        return Response.json({ key });
      }
      if (path !== '/drain') return new Response('Not found', { status: 404 });
      // Only production imports the old shared-KV queue. Staging and recruiter
      // must never consume production work (those envs share KV namespaces).
      if (this.env.RECOVERY_IMPORT_LEGACY === 'on') {
        for (const entry of await takeDueRetries(this.env.SESSIONS)) {
          if (!await this.store.get(entry.retryKey) && !await this.store.get(`recovery-result:${entry.retryKey}`)) {
            await this.store.put(entry.retryKey, JSON.stringify(entry), { metadata: { dueAt: entry.dueAt } });
          }
          await this.env.SESSIONS.delete(entry.retryKey);
        }
      }
      await processDueRetries({ ...this.env, RECOVERY_STORE: this.store });
      // Retain outcomes for seven days, without ever expiring pending work.
      for (const [key, row] of await this.state.storage.list({ prefix: 'recovery-result:' })) {
        if (row.expiresAt && row.expiresAt < Date.now()) await this.state.storage.delete(key);
      }
      return Response.json({ ok: true });
    });
    this.tail = operation;
    return operation;
  }
}

export async function enqueueRecovery(env, entry) {
  if (env.RECOVERY_STORE || !env.RETRY_QUEUE) return scheduleRetry(env.RECOVERY_STORE || env.SESSIONS, entry);
  const stub = env.RETRY_QUEUE.get(env.RETRY_QUEUE.idFromName('recovery'));
  const response = await stub.fetch('https://recovery/enqueue', { method: 'POST', body: JSON.stringify(entry) });
  if (!response.ok) throw new Error(`Recovery queue HTTP ${response.status}`);
}
