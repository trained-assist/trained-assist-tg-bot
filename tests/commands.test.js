import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { timeAgo } from '../src/handlers/commands.js';

describe('timeAgo', () => {
  let now;

  beforeEach(() => {
    now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns "только что" for less than 1 minute ago', () => {
    expect(timeAgo(now - 30_000)).toBe('только что');
    expect(timeAgo(now)).toBe('только что');
  });

  it('returns minutes for < 1 hour', () => {
    expect(timeAgo(now - 2 * 60_000)).toBe('2м');
    expect(timeAgo(now - 59 * 60_000)).toBe('59м');
  });

  it('returns hours for < 24 hours', () => {
    expect(timeAgo(now - 5 * 3600_000)).toBe('5ч');
    expect(timeAgo(now - 23 * 3600_000)).toBe('23ч');
  });

  it('returns days for < 7 days', () => {
    expect(timeAgo(now - 3 * 24 * 3600_000)).toBe('3д');
    expect(timeAgo(now - 6 * 24 * 3600_000)).toBe('6д');
  });

  it('returns formatted date for >= 7 days', () => {
    const old = now - 10 * 24 * 3600_000;
    const result = timeAgo(old);
    // should look like a date string, not just a number
    expect(result).toMatch(/\d/);
    expect(typeof result).toBe('string');
  });
});
