import { describe, expect, it } from 'vitest';
import { assistantMessageFromEvent, liveRunProgress } from '../src/lib/live-run-progress.js';
import { summarizeRunEvent } from '../src/handlers/commands.js';

describe('live OpenCode progress projections', () => {
  it('shows a running timer from the authoritative Runner start time', () => {
    expect(liveRunProgress({ taskStatus: 'running', runStatus: 'running', startedAt: 10_000, now: 82_000 }))
      .toBe('⚙️ OpenCode работает · ⏱ 1 мин 12 сек');
  });

  it('keeps queued and waiting distinguishable from a live model call', () => {
    expect(liveRunProgress({ taskStatus: 'queued' })).toBe('📨 Задача принята, запуск ожидает');
    expect(liveRunProgress({ taskStatus: 'waiting', startedAt: 10_000, now: 25_000 })).toBe('⏳ Ожидаю следующий шаг · ⏱ 15 сек');
    expect(liveRunProgress({ taskStatus: 'done' })).toBe('✅ Выполнено');
    expect(liveRunProgress({ taskStatus: 'done', startedAt: 10_000, finishedAt: 82_000 }))
      .toBe('✅ Выполнено · ⏱ 1 мин 12 сек');
    expect(liveRunProgress({ taskStatus: 'active', runStatus: 'retrying' })).toBe('🔄 Повторяю запуск');
    expect(liveRunProgress({ taskStatus: 'active', runStatus: 'unknown' })).toBe('🔎 Проверяю состояние запуска');
    expect(liveRunProgress({ taskStatus: 'active' })).toBe('⏳ Подготавливаю или проверяю запуск');
  });

  it('accepts the CP event projection but rejects malformed or uncorrelated messages', () => {
    expect(assistantMessageFromEvent({
      sequence: 12, type: 'progress',
      payload: { runId: 'run-1', eventId: 'evt-1', type: 'assistant_message',
        payload: { sessionId: 'ses_1', messageId: 'msg_1', text: 'Сейчас проверю.' } },
    })).toEqual({ runId: 'run-1', eventId: 'evt-1', sessionId: 'ses_1', messageId: 'msg_1', text: 'Сейчас проверю.' });
    expect(assistantMessageFromEvent({ type: 'progress', payload: { type: 'assistant_message', text: 'orphan' } })).toBeNull();
    expect(assistantMessageFromEvent({ type: 'assistant_message', payload: { text: 'wrong nesting' } })).toBeNull();
  });

  it('shows tool names in the log without exposing raw tool arguments', () => {
    const summary = summarizeRunEvent({ type: 'progress', payload: {
      type: 'log', payload: { message: '[opencode tool_use] {"part":{"tool":"read","input":{"token":"private-secret"}}}' },
    } });
    expect(summary).toBe('⚙️ OpenCode: tool_use (read)');
    expect(summary).not.toContain('private-secret');
  });
});
