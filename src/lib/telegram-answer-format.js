import MarkdownIt from 'markdown-it';
import { messageParts } from './message-parts.js';

// HTML is deliberately disabled: only the entity types below may reach Telegram.
const markdown = new MarkdownIt({ html: false, linkify: false, breaks: false });
const MAX_ENTITIES_PER_PART = 100;

export function formatTelegramAnswer(source) {
  if (typeof source !== 'string') throw new TypeError('answer must be text');
  const tokens = markdown.parse(source, {});
  const styled = tokens.some(token => !['paragraph_open', 'paragraph_close', 'inline'].includes(token.type)
    || token.children?.some(child => !['text', 'softbreak', 'hardbreak'].includes(child.type)));
  if (!styled) return { text: source, entities: [] };
  let text = '';
  const entities = [];
  const marks = [];
  const lists = [];
  let quoteDepth = 0;
  const append = value => { text += value; };
  const gap = count => {
    if (!text) return;
    const trailing = /\n*$/.exec(text)[0].length;
    if (trailing < count) append('\n'.repeat(count - trailing));
  };
  const open = (type, extra = {}) => marks.push({ type, offset: text.length, ...extra });
  const close = type => {
    const index = marks.findLastIndex(mark => mark.type === type);
    if (index < 0) return;
    const [mark] = marks.splice(index, 1);
    const length = text.length - mark.offset;
    if (length > 0) entities.push({ type, offset: mark.offset, length, ...(mark.url ? { url: mark.url } : {}) });
  };
  const inline = children => {
    for (const child of children ?? []) {
      switch (child.type) {
        case 'text': case 'html_inline': append(child.content); break;
        case 'softbreak': case 'hardbreak': append(quoteDepth ? '\n│ ' : '\n'); break;
        case 'strong_open': open('bold'); break;
        case 'strong_close': close('bold'); break;
        case 'em_open': open('italic'); break;
        case 'em_close': close('italic'); break;
        case 's_open': open('strikethrough'); break;
        case 's_close': close('strikethrough'); break;
        case 'link_open': {
          const url = child.attrGet('href');
          if (typeof url === 'string' && /^https?:\/\//i.test(url)) open('text_link', { url });
          break;
        }
        case 'link_close': close('text_link'); break;
        case 'code_inline': {
          const offset = text.length;
          append(child.content);
          if (text.length > offset) entities.push({ type: 'code', offset, length: text.length - offset });
          break;
        }
        case 'image': {
          const label = child.content || 'Изображение';
          const offset = text.length;
          append(label);
          const url = child.attrGet('src');
          if (/^https?:\/\//i.test(url ?? '')) entities.push({ type: 'text_link', offset, length: label.length, url });
          break;
        }
        default:
          if (child.content) append(child.content);
      }
    }
  };

  for (const token of tokens) {
    switch (token.type) {
      case 'paragraph_open': if (!lists.length && !quoteDepth) gap(2); break;
      case 'heading_open': gap(2); open('bold'); break;
      case 'heading_close': close('bold'); break;
      case 'inline': inline(token.children); break;
      case 'bullet_list_open': lists.push({ ordered: false, number: 0 }); break;
      case 'ordered_list_open': lists.push({ ordered: true, number: Number(token.attrGet('start')) || 1 }); break;
      case 'bullet_list_close': case 'ordered_list_close': lists.pop(); break;
      case 'list_item_open': {
        gap(1);
        const list = lists.at(-1);
        append(`${'  '.repeat(Math.max(0, lists.length - 1))}${list?.ordered ? `${list.number++}.` : '•'} `);
        break;
      }
      case 'blockquote_open': gap(2); quoteDepth++; append('│ '); break;
      case 'blockquote_close': quoteDepth--; break;
      case 'fence': case 'code_block': {
        gap(2);
        const content = token.content.replace(/\n$/, '');
        const offset = text.length;
        append(content);
        if (content) entities.push({ type: 'pre', offset, length: content.length });
        break;
      }
      case 'hr': gap(2); append('────────'); break;
      default: break;
    }
  }
  text = text.replace(/\n+$/, '');
  if (!text.trim()) return { text: source, entities: [] };
  const safeEntities = entities.filter(entity => entity.offset + entity.length <= text.length);
  // Telegram does not accept links/code/pre overlapping other entities.
  const exclusive = new Set(['text_link', 'code', 'pre']);
  safeEntities.sort((a, b) => Number(exclusive.has(b.type)) - Number(exclusive.has(a.type)) || a.offset - b.offset || b.length - a.length);
  const compatible = [];
  for (const entity of safeEntities) {
    if (compatible.some(other => entity.offset < other.offset + other.length && other.offset < entity.offset + entity.length
      && (exclusive.has(entity.type) || exclusive.has(other.type) || entity.type === other.type))) continue;
    compatible.push(entity);
  }
  compatible.sort((a, b) => a.offset - b.offset || b.length - a.length);
  return { text, entities: compatible };
}

export function formattedAnswerParts(source) {
  const formatted = formatTelegramAnswer(source);
  const texts = messageParts(formatted.text);
  let start = 0;
  return texts.map(text => {
    const end = start + text.length;
    const entities = formatted.entities.flatMap(entity => {
      const from = Math.max(start, entity.offset);
      const to = Math.min(end, entity.offset + entity.length);
      return from < to ? [{ ...entity, offset: from - start, length: to - from }] : [];
    }).slice(0, MAX_ENTITIES_PER_PART);
    start = end;
    return { text, entities };
  });
}
