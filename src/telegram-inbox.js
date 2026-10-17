import { logLifecycleEvent } from './lib/lifecycle-log.js';

const UPDATE_PREFIX = 'telegram-update:';
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 12;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 5 * 60_000;

const updateKey = updateId => `${UPDATE_PREFIX}${String(updateId).padStart(20, '0')}`;
const safeReason = error => typeof error?.code === 'string' && /^[a-z0-9_.-]{1,80}$/i.test(error.code)
  ? error.code.toLowerCase()
  : typeof error?.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(error.name)
    ? error.name : 'dispatch_error';

async function sha256(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Durable inbox for ordinary Telegram message updates. The key is scoped to a conversation DO. */
export class TelegramUpdateInbox {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/admit') return this.admit(request);
    if (request.method === 'GET' && url.pathname === '/status') {
      const requestedLimit = Number(url.searchParams.get('limit') ?? 100);
      const limit = Number.isSafeInteger(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 500)) : 100;
      const records = [...(await this.state.storage.list({ prefix: UPDATE_PREFIX, limit })).values()]
        .sort((a, b) => a.updateId - b.updateId);
      return Response.json({ updates: records.map(({ updateId, state, attempts, acceptedAt, updatedAt, reason }) =>
        ({ updateId, state, attempts, acceptedAt, updatedAt, ...(reason ? { reason } : {}) })) });
    }
    if (request.method === 'POST' && url.pathname === '/retry') {
      const { updateId } = await request.json();
      if (!Number.isSafeInteger(updateId) || updateId < 0) return new Response('invalid updateId', { status: 400 });
      return this.state.storage.transaction(async tx => {
        const record = await tx.get(updateKey(updateId));
        if (!record || record.state !== 'failed') return new Response('not retryable', { status: 409 });
        await tx.put(updateKey(updateId), { ...record, state: 'queued', attempts: 0, updatedAt: Date.now(), reason: null });
        await tx.setAlarm(Date.now() + 1);
        return Response.json({ accepted: true, updateId });
      });
    }
    return new Response('not found', { status: 404 });
  }

  async admit(request) {
    let input;
    try { input = await request.json(); } catch { return new Response('invalid json', { status: 400 }); }
    const { updateId, update } = input ?? {};
    if (!Number.isSafeInteger(updateId) || updateId < 0 || !update || update.update_id !== updateId ||
        !update.message || update.message.message_id == null || update.message.chat?.id == null) {
      return new Response('invalid update', { status: 400 });
    }
    const payload = JSON.stringify(update);
    const fingerprint = await sha256(payload);
    const result = await this.state.storage.transaction(async tx => {
      const key = updateKey(updateId);
      const existing = await tx.get(key);
      if (existing) {
        if (existing.fingerprint !== fingerprint) return { conflict: true };
        return { duplicate: true, state: existing.state };
      }
      const record = { updateId, update, fingerprint, state: 'queued', attempts: 0,
        acceptedAt: Date.now(), updatedAt: Date.now(), nextAttemptAt: Date.now() };
      await tx.put(key, record);
      await tx.setAlarm(Date.now() + 1);
      return { duplicate: false, state: 'queued' };
    });
    if (result.conflict) return new Response('update id payload conflict', { status: 409 });
    logLifecycleEvent({ event: result.duplicate ? 'tg.webhook.update_duplicate' : 'tg.webhook.update_admitted',
      component: 'gateway', correlationId: String(updateId), status: result.state, duplicate: result.duplicate }, this.env);
    return Response.json({ accepted: true, duplicate: result.duplicate, state: result.state, updateId },
      { status: result.duplicate ? 200 : 202 });
  }

  async alarm() {
    const records = [...(await this.state.storage.list({ prefix: UPDATE_PREFIX })).values()]
      .filter(record => ['queued', 'processing'].includes(record.state))
      .sort((a, b) => a.updateId - b.updateId);
    const record = records[0];
    if (!record) return;
    if (record.nextAttemptAt > Date.now()) {
      await this.state.storage.setAlarm(record.nextAttemptAt);
      return;
    }

    const key = updateKey(record.updateId);
    const claimed = await this.state.storage.transaction(async tx => {
      const current = await tx.get(key);
      if (!current || !['queued', 'processing'].includes(current.state)) return null;
      const next = { ...current, state: 'processing', attempts: current.attempts + 1, updatedAt: Date.now() };
      await tx.put(key, next);
      // If the isolate/DO is terminated while dispatch is running, this alarm
      // recovers the same immutable update. Downstream intake deduplicates by
      // Telegram message ID before creating another task.
      await tx.setAlarm(Date.now() + 120_000);
      return next;
    });
    if (!claimed) return;

    logLifecycleEvent({ event: 'tg.webhook.dispatch_started', component: 'gateway',
      correlationId: String(claimed.updateId), status: 'processing', attempt: claimed.attempts }, this.env);

    try {
      const { dispatchInner } = await import('./index.js');
      await dispatchInner(claimed.update, this.env);
      await this.state.storage.transaction(async tx => {
        const current = await tx.get(key);
        if (current?.fingerprint !== claimed.fingerprint) return;
        const { update: _update, ...completed } = current;
        await tx.put(key, { ...completed, state: 'complete', updatedAt: Date.now(), reason: null });
      });
      logLifecycleEvent({ event: 'tg.webhook.dispatch_completed', component: 'gateway',
        correlationId: String(claimed.updateId), status: 'complete', attempt: claimed.attempts }, this.env);
    } catch (error) {
      const attempts = claimed.attempts;
      const failed = attempts >= MAX_ATTEMPTS;
      const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** Math.min(attempts - 1, 8)));
      await this.state.storage.transaction(async tx => {
        const current = await tx.get(key);
        if (current?.fingerprint !== claimed.fingerprint) return;
        await tx.put(key, { ...current, state: failed ? 'failed' : 'queued', updatedAt: Date.now(),
          nextAttemptAt: Date.now() + delay, reason: safeReason(error), ...(failed ? { failedAt: Date.now() } : {}) });
      });
      logLifecycleEvent({ event: 'tg.webhook.dispatch_failed', component: 'gateway',
        correlationId: String(claimed.updateId), status: failed ? 'failed' : 'retrying',
        reasonCode: safeReason(error), attempt: attempts }, this.env);
    }

    const remaining = [...(await this.state.storage.list({ prefix: UPDATE_PREFIX })).values()]
      .filter(item => ['queued', 'processing'].includes(item.state))
      .sort((a, b) => a.updateId - b.updateId);
    if (remaining.length) await this.state.storage.setAlarm(Math.max(Date.now() + 1, remaining[0].nextAttemptAt));
    else await this.state.storage.deleteAlarm();
    await this.prune();
  }

  async prune() {
    const cutoff = Date.now() - RETENTION_MS;
    const records = [...(await this.state.storage.list({ prefix: UPDATE_PREFIX })).entries()];
    const expired = records.filter(([, record]) => ['complete', 'failed'].includes(record.state) && record.updatedAt < cutoff);
    if (expired.length) await this.state.storage.transaction(async tx => {
      for (const [key] of expired) await tx.delete(key);
    });
  }
}

