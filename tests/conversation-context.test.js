import { describe, expect, it } from 'vitest';
import { conversationKey, deliveryContext, threadExtra } from '../src/conversation-context.js';

describe('conversation context', () => {
  it('keeps legacy keys and Telegram payloads without a thread', () => {
    expect(conversationKey(42)).toBe('42');
    expect(threadExtra()).toEqual({});
  });
  it('isolates valid forum threads', () => {
    expect(conversationKey(-100, 7)).toBe('-100:7');
    expect(deliveryContext({ chat: { id: -100 }, message_thread_id: 7 })).toEqual({ chatId: -100, threadId: 7 });
    expect(threadExtra(7)).toEqual({ message_thread_id: 7 });
  });
});
