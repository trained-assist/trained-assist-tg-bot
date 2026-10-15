import { describe, expect, it } from 'vitest';
import { formatTelegramAnswer, formattedAnswerParts } from '../src/lib/telegram-answer-format.js';

describe('Telegram answer formatting', () => {
  it('renders headings, inline styles, links and code as UTF-16 entities', () => {
    const result = formatTelegramAnswer('# Итог\n\n🧪 **жирно** и *курсив*, `x < y`, [ссылка](https://example.com/a?x=1&y=2).');
    expect(result.text).toBe('Итог\n\n🧪 жирно и курсив, x < y, ссылка.');
    const byType = Object.fromEntries(result.entities.map(entity => [entity.type, {
      text: result.text.slice(entity.offset, entity.offset + entity.length), url: entity.url,
    }]));
    expect(byType.bold.text).toBe('жирно');
    expect(byType.italic.text).toBe('курсив');
    expect(byType.code.text).toBe('x < y');
    expect(byType.text_link).toEqual({ text: 'ссылка', url: 'https://example.com/a?x=1&y=2' });
    expect(result.entities).toContainEqual({ type: 'bold', offset: 0, length: 4 });
  });

  it('keeps lists, quotes, fenced code and raw HTML readable without interpreting HTML', () => {
    const result = formatTelegramAnswer('- один\n- два\n\n> цитата\n> дальше\n\n```js\nconst x = "<tag>";\n```\n\n<script>');
    expect(result.text).toContain('• один\n• два');
    expect(result.text).toContain('│ цитата\n│ дальше');
    expect(result.text).toContain('const x = "<tag>";');
    expect(result.text).toContain('<script>');
    expect(result.entities.find(entity => entity.type === 'pre')).toMatchObject({ type: 'pre', length: 18 });
  });

  it('splits formatted visible text without losing characters or entity bounds', () => {
    const source = `# Заголовок\n\n${'**абзац** текст 🧪 '.repeat(230)}`;
    const formatted = formatTelegramAnswer(source);
    const parts = formattedAnswerParts(source);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map(part => part.text).join('')).toBe(formatted.text);
    expect(parts.every(part => part.text.length <= 2000 && part.text.isWellFormed())).toBe(true);
    expect(parts.every(part => part.entities.every(entity => entity.offset >= 0 && entity.length > 0 && entity.offset + entity.length <= part.text.length))).toBe(true);
  });

  it('does not create unsafe links or any styling for ordinary plain text', () => {
    expect(formatTelegramAnswer('Обычный ответ.\n\nВторой абзац.')).toEqual({ text: 'Обычный ответ.\n\nВторой абзац.', entities: [] });
    const result = formatTelegramAnswer('[опасно](javascript:alert(1))');
    expect(result.entities.every(entity => entity.type !== 'text_link')).toBe(true);
  });
});
