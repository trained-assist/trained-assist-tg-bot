import { describe, expect, it } from 'vitest';
import { pingPongAnswerPresent } from '../tools/sandbox3-ping-pong-oracle.mjs';

describe('sandbox3 build ping-pong answer oracle', () => {
  it('accepts a normal non-empty model response without exact formatting', () => {
    expect(pingPongAnswerPresent('I received the request and the sandbox path is working.')).toBe(true);
  });

  it('rejects a missing or whitespace-only answer', () => {
    expect(pingPongAnswerPresent('')).toBe(false);
    expect(pingPongAnswerPresent(' \n\t ')).toBe(false);
    expect(pingPongAnswerPresent(null)).toBe(false);
  });
});
