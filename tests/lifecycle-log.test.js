import { describe, expect, it } from 'vitest';
import { formatLifecycleEvent } from '../src/lib/lifecycle-log.js';

describe('safe lifecycle logging', () => {
  it('keeps bounded correlation and outcome metadata while dropping message and identity fields', () => {
    const line = formatLifecycleEvent({
      event: 'tg.run.finished', component: 'gateway', requestId: 'tgcp-a1b2',
      taskId: 'ut-123', outcome: 'done', status: 'observed', answerPresent: true,
      answerLength: 21, text: 'private prompt', answer: 'private answer',
      chatId: 1714048, username: 'private-user', error: 'private exception',
    }, { BUILD_SHA: 'abcdef0123456789' }, new Date('2026-10-12T12:00:00.000Z'));
    const event = JSON.parse(line);
    expect(event).toEqual({ ts: '2026-10-12T12:00:00.000Z', service: 'trained-assist-tg-bot',
      buildSha: 'abcdef0123456789', event: 'tg.run.finished', component: 'gateway',
      requestId: 'tgcp-a1b2', taskId: 'ut-123', outcome: 'done', status: 'observed',
      answerPresent: true, answerLength: 21 });
    expect(line).not.toContain('private');
    expect(line).not.toContain('1714048');
  });

  it('rejects event names that could inject arbitrary log content', () => {
    expect(() => formatLifecycleEvent({ event: 'run-finished\nsecret=leak' })).toThrow('lifecycle_event_name_invalid');
  });
});
