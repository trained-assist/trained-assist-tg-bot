// Workers KV gives no read-after-write guarantee across requests — a picker tapped
// moments after being shown can read a session that hasn't caught up with the write
// from the message that created it. withKvConsistencyRetry recovers from that by
// re-reading once after a short delay, without slowing down the common already-fresh case.
import { describe, it, expect, vi } from 'vitest';
import { withKvConsistencyRetry } from '../src/lib/kv.js';

describe('withKvConsistencyRetry', () => {
  it('returns the initial session immediately when it already satisfies isReady', async () => {
    const kv = { get: vi.fn() };
    const session = { pendingMessage: 'task' };
    const result = await withKvConsistencyRetry(kv, 42, session, s => !!s?.pendingMessage, 400);
    expect(result).toBe(session);
    expect(kv.get).not.toHaveBeenCalled();
  });

  it('retries once and recovers a session that had not propagated yet', async () => {
    vi.useFakeTimers();
    const fresh = { pendingMessage: 'task' };
    const kv = { get: vi.fn().mockResolvedValue(JSON.stringify(fresh)) };
    const stale = null;
    const promise = withKvConsistencyRetry(kv, 42, stale, s => !!s?.pendingMessage, 400);
    await vi.advanceTimersByTimeAsync(400);
    const result = await promise;
    expect(result).toEqual(fresh);
    expect(kv.get).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('falls back to the original (stale) session if the retry is still not ready', async () => {
    vi.useFakeTimers();
    const kv = { get: vi.fn().mockResolvedValue(null) };
    const stale = null;
    const promise = withKvConsistencyRetry(kv, 42, stale, s => !!s?.pendingMessage, 400);
    await vi.advanceTimersByTimeAsync(400);
    const result = await promise;
    expect(result).toBe(stale);
    vi.useRealTimers();
  });
});
