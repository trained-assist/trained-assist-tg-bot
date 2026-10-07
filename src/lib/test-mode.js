// Test mode (US-TEST-01; design docs/test-mode/DESIGN.md).
//
// A chat listed in TEST_CHAT_IDS (or the sandbox Worker allowlist) travels the
// whole gateway path and gets a real agent answer, but nothing is sent to
// Telegram: gateway effects go to Workers Logs and runs use a reserve chat ID.
// Real users are untouched: with no/empty/garbage TEST_CHAT_IDS nothing matches.
//
// Everything here is synchronous (R14 — no await on the hot path) and fail-safe
// (R13): unparseable input parses to an empty list ⇒ isTestChat is false.
const RESERVE_BASE = 1e14; // reserve id = -(RESERVE_BASE + index) — always negative

let listRaw = null; // memo key: the raw TEST_CHAT_IDS string as seen
let list = []; // parsed ids for that string

function parse(raw) {
  const ids = [];
  for (const part of String(raw ?? '').split(',')) {
    const n = Number(part.trim());
    if (part.trim() !== '' && Number.isSafeInteger(n) && n !== 0) ids.push(n);
  }
  return ids;
}

function idsFor(env) {
  // The isolated Control Plane sandbox has no reliable Telegram API delivery.
  // Treat its explicitly allowlisted chats as test chats unless configured
  // otherwise, so webhook inputs still traverse the production-shaped handler
  // while every outbound effect is recorded in Workers Logs.
  const sandboxChats = env?.TG_HTTP_TEST_MODE === 'true'
    ? env?.TG_SLICE_ALLOWED_CHATS : '';
  const raw = String(env?.TEST_CHAT_IDS ?? sandboxChats ?? '');
  if (raw !== listRaw) { list = parse(raw); listRaw = raw; }
  return list;
}

// ── env-scoped checks (call sites where env is in hand) ──────────────────────

export function isTestChat(env, chatId) {
  const n = Number(chatId);
  if (!Number.isSafeInteger(n) || n === 0) return false;
  return idsFor(env).includes(n);
}

export function testChatList(env) {
  return [...idsFor(env)];
}

// Layer B (§2.1): swap to a dead id that is always a NEGATIVE safe integer —
// the gateway's own validation accepts it (negative group ids are legal) while
// no real Telegram chat can match it: if the agent ignores delivery:"log" its
// sends 400 into the void instead of leaking into the live chat.
export function reserveChatId(env, chatId) {
  const i = idsFor(env).indexOf(Number(chatId));
  return i < 0 ? chatId : -(RESERVE_BASE + i);
}

// Inverse: run-finished / held-messages come BACK with the reserve id and must
// reach the real chat's IntakeBuffer (otherwise `busy` never releases).
// Ids not in the current list pass through untouched.
export function realChatId(env, chatId) {
  const n = Number(chatId);
  if (!Number.isSafeInteger(n)) return chatId;
  const ids = idsFor(env);
  const i = -n - RESERVE_BASE;
  return Number.isInteger(i) && i >= 0 && i < ids.length && -(RESERVE_BASE + i) === n
    ? ids[i]
    : chatId;
}

// The single switchover on the LAST hop before POST /run (RunOutbox.alarm and
// runTask's direct path): flag AND reserve id are set in ONE branch, so the
// gateway can never emit "swapped but without the flag" (§2.1). Logs the
// `run-start` journal line with the REAL chat id; no-op for regular chats.
export function applyTestDelivery(env, body) {
  const real = Number(body?.userId);
  const ids = idsFor(env);
  const i = Number.isSafeInteger(real) ? ids.indexOf(real) : -1;
  if (i < 0) return false;
  const reserve = -(RESERVE_BASE + i);
  body.chatId = reserve;
  body.userId = reserve;
  body.delivery = 'log';
  console.log(`[test-mode] run-start chat=${real} requestId=${body.requestId ?? '-'} delivery=log`);
  return true;
}

// ── module cache for lib/telegram.js ─────────────────────────────────────────
// Those helpers receive only `token` — threading env through ~10 functions and
// dozens of call sites would widen the gate far beyond the change. The three
// init points (dispatchInner, IntakeBuffer constructor, processDueRetries)
// cover every importer of telegram.js (DESIGN §2.2); an uninitialised cache =
// no match = ordinary sends (same fail-safe).

let cached = null;

export function initTestMode(env) {
  cached = idsFor(env);
}

export function isTestChatCached(chatId) {
  if (!cached) return false;
  const n = Number(chatId);
  return Number.isSafeInteger(n) && n !== 0 && cached.includes(n);
}

// Journal line in place of a send; the stub keeps callers working without a
// `result` (recordSent/trackUI no-op on a missing message_id — a suppressed
// message must never be remembered in KV as if it existed).
export function suppress(chatId, kind, detail) {
  const text = String(detail ?? '').replace(/\s+/g, ' ').slice(0, 300);
  console.log(`[test-mode] kind=${kind} chat=${chatId} text=${text}${text.length >= 300 ? '…' : ''}`);
  return { ok: true, suppressed: true };
}

// ── callback-ack registry ────────────────────────────────────────────────────
// answerCallbackQuery carries no chat id — only a callback_query_id. The
// dispatcher registers each incoming callback with its chat id (dispatchInner),
// and the ack matches against that registry: only callbacks that ARRIVED from a
// test chat are suppressed; a foreign/unregistered id is answered normally.

const CB_TTL_MS = 10 * 60 * 1000;
const CB_CAP = 256;
const callbacks = new Map(); // callbackQueryId -> { chatId, at }

export function rememberCallback(callbackId, chatId) {
  if (!callbackId || chatId == null) return;
  const now = Date.now();
  for (const [id, e] of callbacks) if (now - e.at > CB_TTL_MS) callbacks.delete(id);
  if (callbacks.size >= CB_CAP) callbacks.delete(callbacks.keys().next().value);
  callbacks.set(callbackId, { chatId, at: now });
}

export function callbackChatId(callbackId) {
  const entry = callbacks.get(callbackId);
  if (!entry) return null;
  if (Date.now() - entry.at > CB_TTL_MS) { callbacks.delete(callbackId); return null; }
  return entry.chatId;
}
