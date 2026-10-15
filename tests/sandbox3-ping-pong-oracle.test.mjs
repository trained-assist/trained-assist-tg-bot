import { describe, expect, it } from 'vitest';
import { extractDeliverableAnswer, pingPongAnswerPresent } from '../tools/sandbox3-ping-pong-oracle.mjs';

describe('sandbox3 build ping-pong answer oracle', () => {
  it('accepts a normal non-empty model response without exact formatting', () => {
    expect(pingPongAnswerPresent('I received the request and the sandbox path is working.')).toBe(true);
  });

  it('accepts a long answer; verbosity is not a task failure', () => {
    expect(pingPongAnswerPresent('The sandbox path is working. '.repeat(9))).toBe(true);
  });

  it('rejects a missing or whitespace-only answer', () => {
    expect(pingPongAnswerPresent('')).toBe(false);
    expect(pingPongAnswerPresent(' \n\t ')).toBe(false);
    expect(pingPongAnswerPresent(null)).toBe(false);
  });

  it('rejects explicit task and executor failure banners', () => {
    expect(pingPongAnswerPresent('❌ Задача завершилась ошибкой. Подробности отправлены отдельным сообщением.')).toBe(false);
    expect(pingPongAnswerPresent('Ошибка исполнителя.')).toBe(false);
    expect(pingPongAnswerPresent('Ошибка исполнителя: выбранный движок недоступен.')).toBe(false);
  });

  it('does not treat ordinary discussion of errors as a failure banner', () => {
    expect(pingPongAnswerPresent('The system is working; I can explain the error handling if useful.')).toBe(true);
  });

  it('extracts only the answer production delivery would send', () => {
    expect(extractDeliverableAnswer({ answer: 'A verbose but valid response.' })).toBe('A verbose but valid response.');
    expect(extractDeliverableAnswer('Plain text response.')).toBe('Plain text response.');
    expect(extractDeliverableAnswer({ metadata: 'this must not count as an answer' })).toBe('');
    expect(extractDeliverableAnswer({ content: [{ type: 'text', text: 'not the delivery contract' }] })).toBe('');
  });
});
