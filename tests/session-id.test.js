import { describe, it, expect } from 'vitest';
import { newSessionId } from '../src/lib/kv.js';

// Guards the chatId-sign-split invariant: session-id generation must live in ONE
// place and produce a single, stable format. Copy-pasted `s-${Math.abs(chatId)}…`
// across 6 handlers is how a group chat forked into two families and lost its ТЗ.
describe('newSessionId', () => {
  it('produces the canonical s-<absChat>-<ts> shape for a negative (group) chatId', () => {
    const id = newSessionId(-1003814002203);
    expect(id).toMatch(/^s-1003814002203-\d+$/);
  });

  it('produces the same shape for a positive chatId', () => {
    const id = newSessionId(1003814002203);
    expect(id).toMatch(/^s-1003814002203-\d+$/);
  });

  it('never emits the double-dash raw-negative form (the divergent family)', () => {
    expect(newSessionId(-42)).not.toContain('s--');
  });
});
