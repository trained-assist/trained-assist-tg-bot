export const MESSAGE_PART_LIMIT = 2000;
export const COMPLETE_ANSWER_LIMIT = 100000;

// Plain text (the delivery owner's existing parse_mode=null contract). Keep
// every source character; the parts can be joined verbatim to reconstruct it.
export function messageParts(text, limit = MESSAGE_PART_LIMIT) {
  if (!Number.isSafeInteger(limit) || limit < 2) throw new Error('invalid_message_limit');
  if (text.length <= limit) return [text];
  const boundaries = new Set([0]);
  for (const item of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
    boundaries.add(item.index + item.segment.length);
  }
  const parts = [];
  let start = 0;
  while (start < text.length) {
    if (text.length - start <= limit) { parts.push(text.slice(start)); break; }
    let end = start + limit;
    while (end > start && !boundaries.has(end)) end--;
    // A pathological single grapheme can itself exceed the delivery ceiling.
    // In that case retain valid Unicode code points and still make progress.
    if (end === start) {
      end = start + limit;
      if (/[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
    }
    const window = text.slice(start, end);
    for (const pattern of [/\r?\n[ \t]*\r?\n/g, /\r?\n/g, /\s+/gu]) {
      let candidate = 0;
      for (const match of window.matchAll(pattern)) candidate = match.index + match[0].length;
      if (candidate >= Math.floor(limit / 4) && boundaries.has(start + candidate)) {
        end = start + candidate;
        break;
      }
    }
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}
