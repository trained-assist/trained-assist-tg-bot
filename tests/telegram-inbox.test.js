import { afterEach, describe, expect, it, vi } from 'vitest';

const dispatchInner = vi.fn();
vi.mock('../src/index.js', () => ({ dispatchInner }));
const { TelegramUpdateInbox } = await import('../src/telegram-inbox.js');

class MemoryStorage {
  data = new Map();
  alarmAt = null;
  async get(key) { return this.data.get(key); }
  async put(key, value) { this.data.set(key, structuredClone(value)); }
  async delete(key) { this.data.delete(key); }
  async list({ prefix = '' } = {}) {
    return new Map([...this.data.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value)]));
  }
  async transaction(callback) { return callback(this); }
  async setAlarm(at) { this.alarmAt = at; }
  async deleteAlarm() { this.alarmAt = null; }
}

function fixture() {
  const storage = new MemoryStorage();
  const inbox = new TelegramUpdateInbox({ storage }, {});
  return { inbox, storage };
}

function update(updateId = 17, messageId = 42, text = 'hello') {
  return { update_id: updateId, message: { message_id: messageId, chat: { id: 1714048 }, text } };
}

async function admit(inbox, value) {
  return inbox.fetch(new Request('https://inbox/admit', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ updateId: value.update_id, update: value }) }));
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('durable Telegram update admission', () => {
  it('persists the immutable update and arms recovery before acknowledging it', async () => {
    const { inbox, storage } = fixture();
    const response = await admit(inbox, update());
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ accepted: true, state: 'queued', updateId: 17 });
    expect(storage.data.get('telegram-update:00000000000000000017')).toMatchObject({
      state: 'queued', update: update(), fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(storage.alarmAt).not.toBeNull();
  });

  it('deduplicates the same Telegram update and rejects a reused ID with different content', async () => {
    const { inbox, storage } = fixture();
    await admit(inbox, update());
    const duplicate = await admit(inbox, update());
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ accepted: true, duplicate: true, state: 'queued' });
    const conflict = await admit(inbox, update(17, 43, 'different payload'));
    expect(conflict.status).toBe(409);
    expect(storage.data.size).toBe(1);
  });

  it('dispatches an admitted update and records completion without retaining its payload', async () => {
    const { inbox, storage } = fixture();
    await admit(inbox, update());
    await inbox.alarm();
    expect(dispatchInner).toHaveBeenCalledOnce();
    expect(dispatchInner).toHaveBeenCalledWith(update(), {});
    const completed = storage.data.get('telegram-update:00000000000000000017');
    expect(completed).toMatchObject({ state: 'complete', attempts: 1 });
    expect(completed).not.toHaveProperty('update');
  });

  it('replays an interrupted processing record and records a bounded retry after a transient failure', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-14T12:00:00Z'));
    const { inbox, storage } = fixture();
    await admit(inbox, update());
    const key = 'telegram-update:00000000000000000017';
    const record = storage.data.get(key);
    storage.data.set(key, { ...record, state: 'processing', nextAttemptAt: Date.now() });
    dispatchInner.mockRejectedValueOnce(Object.assign(new Error('temporary'), { code: 'upstream_unavailable' }));
    await inbox.alarm();
    expect(storage.data.get(key)).toMatchObject({ state: 'queued', attempts: 1, reason: 'upstream_unavailable' });
    const retryAt = storage.data.get(key).nextAttemptAt;
    vi.setSystemTime(retryAt);
    dispatchInner.mockResolvedValueOnce(undefined);
    await inbox.alarm();
    expect(dispatchInner).toHaveBeenCalledTimes(2);
    expect(storage.data.get(key)).toMatchObject({ state: 'complete', attempts: 2 });
  });

  it('retains terminal failures for inspection and supports an explicit retry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-14T12:00:00Z'));
    const { inbox, storage } = fixture();
    await admit(inbox, update());
    const key = 'telegram-update:00000000000000000017';
    for (let attempt = 0; attempt < 12; attempt += 1) {
      dispatchInner.mockRejectedValueOnce(Object.assign(new Error('temporary'), { code: 'upstream_unavailable' }));
      await inbox.alarm();
      const record = storage.data.get(key);
      if (record.state === 'failed') break;
      vi.setSystemTime(record.nextAttemptAt);
    }
    expect(storage.data.get(key)).toMatchObject({ state: 'failed', attempts: 12, reason: 'upstream_unavailable' });
    const status = await inbox.fetch(new Request('https://inbox/status'));
    const statusBody = await status.json();
    expect(statusBody).toMatchObject({ updates: [{ updateId: 17, state: 'failed', attempts: 12 }] });
    expect(JSON.stringify(statusBody)).not.toContain('hello');
    expect(JSON.stringify(statusBody)).not.toContain('message');
    const retried = await inbox.fetch(new Request('https://inbox/retry', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ updateId: 17 }) }));
    expect(retried.status).toBe(200);
    expect(storage.data.get(key)).toMatchObject({ state: 'queued', attempts: 0 });
  });
});
