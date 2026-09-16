import { describe, it, expect } from 'vitest';
import { scheduleRetry, takeDueRetries, markRetryStarted, finishRetry } from '../src/lib/kv.js';

// Class B self-heal (issue #604): the actual KV mechanics behind the retry
// queue, exercised against a minimal fake KV (not mocked away) — this is what
// guarantees cap-at-1 in production, not just in the message.js orchestration test.
function fakeKv() {
  const store = new Map(); // name -> { value, metadata }
  return {
    async put(name, value, { metadata } = {}) {
      store.set(name, { value, metadata });
    },
    async get(name) {
      return store.get(name)?.value ?? null;
    },
    async delete(name) {
      store.delete(name);
    },
    async list({ prefix }) {
      return {
        keys: [...store.entries()]
          .filter(([name]) => name.startsWith(prefix))
          .map(([name, { metadata }]) => ({ name, metadata })),
      };
    },
    _size: () => store.size,
  };
}

describe('retry queue KV mechanics', () => {
  it('a freshly scheduled retry is NOT due yet', async () => {
    const kv = fakeKv();
    await scheduleRetry(kv, { chatId: 42, text: 't', opts: {} });
    expect(await takeDueRetries(kv)).toEqual([]);
    expect(kv._size()).toBe(1); // still queued, not consumed
  });

  it('a retry whose dueAt has passed is returned and retained until acknowledged', async () => {
    const kv = fakeKv();
    await kv.put('retry:42:1', JSON.stringify({ chatId: 42, text: 'сделай', opts: {}, dueAt: Date.now() - 1000 }),
      { metadata: { dueAt: Date.now() - 1000 } });

    const due = await takeDueRetries(kv);
    expect(due).toEqual([{ chatId: 42, text: 'сделай', opts: {}, dueAt: expect.any(Number), retryKey: 'retry:42:1' }]);
    expect(kv._size()).toBe(1);
  });

  it('a second cron tick finds nothing left — cap-at-1 via deletion, not a flag', async () => {
    const kv = fakeKv();
    await kv.put('retry:42:1', JSON.stringify({ chatId: 42, text: 'x', opts: {}, dueAt: Date.now() - 1000 }),
      { metadata: { dueAt: Date.now() - 1000 } });

    const [entry] = await takeDueRetries(kv);
    await finishRetry(kv, entry, 'accepted');
    expect(await takeDueRetries(kv)).toEqual([]);
  });

  it('only pops entries that are due, leaving not-yet-due ones queued', async () => {
    const kv = fakeKv();
    const due1 = Date.now() - 1000;
    const notDue = Date.now() + 60_000;
    await kv.put('retry:1:a', JSON.stringify({ chatId: 1, text: 'a', opts: {}, dueAt: due1 }), { metadata: { dueAt: due1 } });
    await kv.put('retry:2:b', JSON.stringify({ chatId: 2, text: 'b', opts: {}, dueAt: notDue }), { metadata: { dueAt: notDue } });

    const due = await takeDueRetries(kv);
    expect(due).toHaveLength(1);
    expect(due[0].chatId).toBe(1);
    expect(kv._size()).toBe(2); // chat 2's entry is still queued
  });
});
