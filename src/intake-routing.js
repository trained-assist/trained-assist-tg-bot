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

/** True when a message should be routed through the intake accumulator. */
export function shouldDebounce(msg, env) {
  if (env.INTAKE_DEBOUNCE === 'off') return false; // kill-switch; default ON
  if (!env.INTAKE) return false;                   // binding missing → fail open
  const text = msg.text;
  if (!text) return false;                         // voice/photo/doc bypass (v1)
  if (text.startsWith('/')) return false;          // commands bypass
  if (msg.reply_to_message) return false;          // answering the bot bypasses
  return true;
}

/** Coalesce a buffer of {text,msg} items into one launch task string. */
export function coalesceBuffer(buf) {
  return buf.map(i => i.text).filter(Boolean).join('\n');
}
