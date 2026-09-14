// Pure intake routing + coalescing decisions for the gateway accumulator.
// Extracted from index.js / intake-buffer.js so the real decision code is
// unit-testable and vendorable into staging Harness A verbatim (no heavy deps).
//
// This module holds the two decisions that define the intake behaviour:
//   • shouldDebounce(msg, env) — does a message go through the buffer at all?
//   • coalesceBuffer(buf)      — how do buffered items become one launch task?
// Keeping them here (and out of index.js, which pulls in the whole gateway) is
// what lets staging pin a verbatim copy and assert against the REAL logic.

// A standalone launch word flushes the buffer immediately; otherwise launch is
// by the ▶️ button. Must be a whole-string match — a broad regex used to fire on
// prose like «давай сделаем…» / «…го…» (the «стартует сразу» bug, #530).
export const FORCE_RUN_RE = /^\s*(запускай|запусти|поехали|го|go|run|начинай)\s*[!.]*\s*$/i;

/** Does this message carry anything worth accumulating (text or media)? */
export function hasIntakeContent(msg) {
  return !!(msg && (msg.text || msg.photo || msg.voice || msg.audio || msg.document || msg.video));
}

/** True when a message should be routed through the intake accumulator. */
export function shouldDebounce(msg, env) {
  if (env.INTAKE_DEBOUNCE === 'off') return false; // kill-switch; default ON
  if (!env.INTAKE) return false;                   // binding missing → fail open
  if (msg.reply_to_message) return false;          // answering the bot bypasses
  const text = msg.text;
  if (text && text.startsWith('/')) return false;  // commands bypass
  // Media WITHOUT text (photo/voice/doc/audio/video) MUST also accumulate — the
  // user is often assembling a task from a file + a follow-up line. Firing on the
  // first media message was the R3 «фото стартует само» bug (#66). Only a message
  // with no content at all skips the buffer.
  return hasIntakeContent(msg);
}

// One buffer item → its text representation for the coalesced launch task.
// Text wins; then an async voice/audio transcript the gateway attached; then a
// stable media tag so the launch still «sees» that a file was sent.
export function coalesceItem(item) {
  if (item?.text) return item.text;
  const m = item?.msg || {};
  if (m.transcript) return m.transcript;
  const tag = (kind, v) => {
    if (!v) return null;
    if (typeof v === 'string') return `${kind}:${v}`;
    const name = v.file_name || v.file_unique_id || v.file_id;
    return name ? `${kind}:${name}` : kind;
  };
  return tag('photo', Array.isArray(m.photo) ? m.photo[m.photo.length - 1] : m.photo)
      || tag('voice', m.voice)
      || tag('audio', m.audio)
      || tag('document', m.document)
      || tag('video', m.video)
      || '';
}

/** Coalesce a buffer of {text,msg} items into one launch task string. */
export function coalesceBuffer(buf) {
  return buf.map(coalesceItem).filter(Boolean).join('\n');
}
