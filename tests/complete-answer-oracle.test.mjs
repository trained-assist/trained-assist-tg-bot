import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { verifyCompleteAnswer } from '../tools/complete-answer-oracle.mjs';
const parts = ['A'.repeat(1200) + '\n\n', 'Б'.repeat(1200)];
const record = { status: 'sent', partCount: 2, sentParts: 2, providerMessageIds: [11, 12],
  textCharacterCount: parts.join('').length, textSha256: createHash('sha256').update(parts.join('')).digest('hex') };
it('compares all actual provider messages to the complete source digest', () => {
  expect(verifyCompleteAnswer(record, parts)).toBe(parts.join(''));
});
it('compares formatted provider text to its display digest while retaining a different source digest', () => {
  const visible = parts.join('');
  const styled = { ...record, textSha256: createHash('sha256').update(`**${visible}**`).digest('hex'),
    displayTextCharacterCount: visible.length, displayTextSha256: createHash('sha256').update(visible).digest('hex') };
  expect(verifyCompleteAnswer(styled, parts)).toBe(visible);
});
it.each([
  [{ ...record, sentParts: 1 }, parts],
  [{ ...record, providerMessageIds: [11, 11] }, parts],
  [record, parts.toReversed()],
  [record, [parts[0], parts[1].slice(1)]],
  [record, [parts.join('')]],
])('rejects partial, duplicated, reordered, clipped or oversized delivery', (receipt, messages) => {
  expect(() => verifyCompleteAnswer(receipt, messages)).toThrow();
});

it('restores only provider-trimmed message-edge separators with an exact source digest', () => {
  expect(verifyCompleteAnswer(record, [parts[0].trimEnd(), parts[1]])).toBe(parts.join(''));
  expect(() => verifyCompleteAnswer(record, [parts[0].slice(1).trimEnd(), parts[1]])).toThrow();
});
