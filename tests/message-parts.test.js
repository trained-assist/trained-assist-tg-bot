import { describe, it, expect } from 'vitest';
import { messageParts } from '../src/lib/message-parts.js';
describe('complete answer paragraph parts', () => {
  it('prefers paragraph boundaries and retains every source character', () => {
    const paragraphs = ['A'.repeat(900), 'B'.repeat(900), 'C'.repeat(900), 'END'];
    const text = paragraphs.join('\n\n');
    const parts = messageParts(text);
    expect(parts.join('')).toBe(text);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe(`${paragraphs[0]}\n\n${paragraphs[1]}\n\n`);
    expect(parts.every(part => part.length <= 2000)).toBe(true);
  });
  it.each([
    'Длинный абзац с пробелами и эмодзи 🧪. '.repeat(250),
    '👩‍👩‍👧‍👦'.repeat(500),
    'x'.repeat(6000),
    '# Title\r\n\r\n' + 'line\r\n'.repeat(1000),
    '```sql\nSELECT 1;\n\n'.repeat(250) + '```\n\nhttps://example.test/path?a=1&b=2',
  ])('splits long text without loss or invalid Unicode', text => {
    const parts = messageParts(text);
    expect(parts.join('')).toBe(text);
    expect(parts.every(part => part.length > 0 && part.length <= 2000)).toBe(true);
    expect(parts.every(part => part.isWellFormed())).toBe(true);
    if (text.startsWith('👩')) expect(parts.every(part => part.length % '👩‍👩‍👧‍👦'.length === 0)).toBe(true);
  });
});
