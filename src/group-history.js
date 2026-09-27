// Group history: what was said in a group while the bot stayed quiet.
//
// With all-messages mode off, a group message not addressed to the bot used to be
// dropped without a trace, so «@bot посмотри, что Петя писал выше» reached the agent
// with no idea what Петя wrote. The gateway now keeps those ambient messages in a
// small rolling buffer (last HISTORY_TTL_MS, at most HISTORY_MAX entries) inside the
// chat's IntakeBuffer Durable Object (strongly consistent, per chat/forum topic, no new
// DO class) and runTask prepends them to /run `context` for group chats.
//
// Only logged-in groups record (the caller checks the session); /history_off disables
// recording for a chat and wipes what was kept, /history_on turns it back on.
//
// Delivery cursor: every entry gets a monotonic `seq` in the DO; a run carries only the
// entries after the chat's `delivered` cursor, and the cursor moves only once the agent
// accepted the run (ackGroupHistory). So a message reaches the agent's prompt once — the
// next run doesn't repeat it. The run also carries the entries structured
// (body.groupHistory); the agent keeps them on disk and serves them via the
// get_group_history MCP tool, so already-delivered messages stay readable.
// Pure helpers here + thin DO client; the storage side lives in IntakeBuffer.

import { conversationKey } from './conversation-context.js';

export const HISTORY_TTL_MS = 24 * 60 * 60 * 1000;
export const HISTORY_MAX = 50;
export const HISTORY_TEXT_MAX = 1000;
export const HISTORY_BLOCK_MAX = 12000;

export function isGroupChatId(chatId) {
  return Number(chatId) < 0;
}

function authorOf(msg) {
  const f = msg?.from || {};
  const name = [f.first_name, f.last_name].filter(Boolean).join(' ').trim();
  if (name && f.username) return `${name} (@${f.username})`;
  return name || (f.username ? `@${f.username}` : (msg?.sender_chat?.title || 'участник'));
}

function mediaTag(msg) {
  if (msg?.voice) return '[голосовое]';
  if (msg?.audio) return '[аудио]';
  if (msg?.video || msg?.video_note) return '[видео]';
  if (msg?.photo) return '[фото]';
  if (msg?.document) return `[файл${msg.document.file_name ? ` ${msg.document.file_name}` : ''}]`;
  return '';
}

/** Compact, storable record of one ambient group message, or null if nothing to keep. */
export function historyEntry(msg, now = Date.now()) {
  const tag = mediaTag(msg);
  let text = String(msg?.text || msg?.caption || '').trim();
  if (text.length > HISTORY_TEXT_MAX) text = text.slice(0, HISTORY_TEXT_MAX) + '…';
  const body = [tag, text].filter(Boolean).join(' ');
  if (!body) return null;
  const ts = Number.isFinite(msg?.date) ? msg.date * 1000 : now;
  return { id: msg?.message_id ?? null, ts, from: authorOf(msg), text: body };
}

/** Keep entries within the window, dedup by message id, oldest first, capped. */
export function pruneHistory(entries, now = Date.now()) {
  const seen = new Set();
  const kept = [];
  for (const e of (Array.isArray(entries) ? entries : [])) {
    if (!e || now - e.ts > HISTORY_TTL_MS) continue;
    if (e.id != null) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
    }
    kept.push(e);
  }
  kept.sort((a, b) => a.ts - b.ts);
  return kept.slice(-HISTORY_MAX);
}

function mskTime(ts) {
  const d = new Date(ts + 3 * 60 * 60 * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** Highest delivery seq among entries (0 if none carry one). */
export function maxSeq(entries) {
  let m = 0;
  for (const e of (Array.isArray(entries) ? entries : [])) if (Number.isSafeInteger(e?.seq) && e.seq > m) m = e.seq;
  return m;
}

/** Reference block for the agent; newest lines win if the block would be too long. */
export function formatHistoryBlock(entries) {
  if (!entries?.length) return '';
  const lines = entries.map(e => `[${mskTime(e.ts)} МСК] ${e.from}: ${e.text}`);
  let total = 0;
  let start = lines.length;
  while (start > 0 && total + lines[start - 1].length + 1 <= HISTORY_BLOCK_MAX) total += lines[--start].length + 1;
  const shown = lines.slice(start);
  const omitted = start > 0 ? `(ранние ${start} сообщ. опущены)\n` : '';
  return (
    'История группы — НОВЫЕ с прошлой задачи сообщения участников, НЕ адресованные боту ' +
    '(справочно; текущая задача — ниже; ранее переданные — через get_group_history):\n' +
    omitted + shown.join('\n')
  );
}

function stub(env, chatId, threadId) {
  return env.INTAKE.get(env.INTAKE.idFromName(conversationKey(chatId, threadId)));
}

/** Record an ambient group message. Never throws: history must not break routing. */
export async function recordGroupMessage(env, msg, threadId = null) {
  try {
    if (!env?.INTAKE) return false;
    const entry = historyEntry(msg);
    if (!entry) return false;
    const res = await stub(env, msg.chat.id, threadId).fetch('https://intake/group-history', {
      method: 'POST', body: JSON.stringify({ entry }),
    });
    return res.ok;
  } catch (e) {
    console.warn(`[group-history] record failed chat=${msg?.chat?.id}: ${e?.message || e}`);
    return false;
  }
}

/** Not-yet-delivered entries of a group chat ([] if none / disabled / error). */
export async function pendingGroupHistory(env, chatId, threadId = null) {
  try {
    if (!env?.INTAKE || !isGroupChatId(chatId)) return [];
    const res = await stub(env, chatId, threadId).fetch('https://intake/group-history?pending=1');
    if (!res.ok) return [];
    const { entries } = await res.json();
    return pruneHistory(entries);
  } catch (e) {
    console.warn(`[group-history] read failed chat=${chatId}: ${e?.message || e}`);
    return [];
  }
}

/** The formatted block of not-yet-delivered entries ('' if none / disabled / error). */
export async function groupHistoryBlock(env, chatId, threadId = null) {
  return formatHistoryBlock(await pendingGroupHistory(env, chatId, threadId));
}

/** Mark entries up to `seq` as delivered. Never throws: worst case they repeat once. */
export async function ackGroupHistory(env, chatId, threadId, seq) {
  try {
    if (!env?.INTAKE || !isGroupChatId(chatId) || !(seq > 0)) return false;
    const res = await stub(env, chatId, threadId).fetch('https://intake/group-history/ack', {
      method: 'POST', body: JSON.stringify({ seq }),
    });
    return res.ok;
  } catch (e) {
    console.warn(`[group-history] ack failed chat=${chatId}: ${e?.message || e}`);
    return false;
  }
}

/** Turn recording on/off for a chat; off also wipes the kept history. Returns previous state. */
export async function setGroupHistoryEnabled(env, chatId, threadId, enabled) {
  const res = await stub(env, chatId, threadId).fetch('https://intake/group-history/mode', {
    method: 'POST', body: JSON.stringify({ enabled: !!enabled }),
  });
  if (!res.ok) throw new Error(`group-history mode HTTP ${res.status}`);
  return res.json();
}
