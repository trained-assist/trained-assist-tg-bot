import { describe, expect, it } from 'vitest';
import { conversationKey, deliveryContext, threadExtra } from '../src/conversation-context.js';

describe('conversation context', () => {
  it('keeps legacy keys and Telegram payloads without a thread', () => {
    expect(conversationKey(42)).toBe('42');
    expect(threadExtra()).toEqual({});
  });
  it('isolates valid forum threads', () => {
    expect(conversationKey(-100, 7)).toBe('-100:7');
    expect(deliveryContext({ chat: { id: -100 }, is_topic_message: true, message_thread_id: 7 })).toEqual({ chatId: -100, threadId: 7 });
    expect(threadExtra(7)).toEqual({ message_thread_id: 7 });
  });
});


it.each(['private', 'group', 'supergroup'])('ordinary %s reply root is not a forum topic', type => {
  expect(deliveryContext({ chat: { id: -100, type }, message_thread_id: 717,
    reply_to_message: { message_id: 717 } })).toEqual({ chatId: -100 });
});
it('accepts explicit internal context and forum chat metadata', () => {
  expect(deliveryContext({ chatId: -100, threadId: 7 })).toEqual({ chatId: -100, threadId: 7 });
  expect(deliveryContext({ chat: { id: -100, is_forum: true }, message_thread_id: 7 })).toEqual({ chatId: -100, threadId: 7 });
});
