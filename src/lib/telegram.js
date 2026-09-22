import { trackUI, forgetUI } from './transient-ui.js';
import commandsRegistry from '../../commands-registry.json';
// Telegram Bot API helpers

// One-shot per isolate: register the bot's command menu on Telegram as soon as
// the worker boots. Driven by commands-registry.json (already imported for the
// AGENT_FORWARDED_COMMANDS set in handlers/commands.js) so the menu and the
// switch stay in sync forever — the old hardcoded lists in scripts/set-commands*.js
// kept drifting and the menu went stale (issue: "/hh_* отсутствует в меню").
//
// Hidden and adminOnly entries are intentionally excluded: a hidden command is
// hidden by definition, and adminOnly ones must not be advertised to regular
// users via the menu (they're still callable when typed directly).
//
// audience: 'recruiter' additionally drops entries marked recruiterHidden:true —
// dev/ops/personal-assistant commands (OpenCode profile switches, Chrome-ext
// pairing, GTD checklists, etc.) that don't belong on a recruiter's menu. See
// wrangler.toml env.recruiter (BOT_USERNAME=super_recruiter_assistant_bot).
// Symmetrically, entries marked recruiterOnly:true (HH/vacancy commands) are
// dropped for every OTHER audience — the personal-assistant bot has no HH
// skill enabled, so those commands were dead clutter in its menu/start list.
//
// Telegram limits: 100 commands/scope, 30 setMyCommands/min. Per-isolate call
// is fine even under burst cold-start; if many isolates race, Telegram returns
// 429 and we silently log — next boot retries.
export async function registerBotCommands(token, { audience = 'default' } = {}) {
  if (!token) return { ok: false, reason: 'no token' };
  const seen = new Set();
  const commands = [];
  for (const entry of commandsRegistry.commands) {
    if (entry.hidden || entry.adminOnly) continue;
    if (audience === 'recruiter' && entry.recruiterHidden) continue;
    if (audience !== 'recruiter' && entry.recruiterOnly) continue;
    if (seen.has(entry.command)) continue;
    seen.add(entry.command);
    const name = entry.command.replace(/^\//, '');
    // Telegram rejects the WHOLE batch if any single command is invalid — one bad
    // entry silently freezes every bot's menu at whatever was last registered
    // successfully (found 2026-09-22: "/oc_lavish-luna" had a hyphen, which
    // Telegram's command charset [a-z0-9_] forbids, and had been failing every
    // isolate boot since #169 — nobody noticed because the failure is a log line,
    // not a user-visible error). Validate defensively so a future bad addition
    // degrades to "menu missing one command" instead of "menu never updates again".
    if (!/^[a-z0-9_]{1,32}$/.test(name)) {
      console.error(`[setMyCommands] skipping "${name}" — invalid Telegram command name (must be 1-32 chars, lowercase a-z0-9_ only). Fix in commands-registry.json or hide via hidden:true.`);
      continue;
    }
    if ((entry.description || '').length > 256) {
      console.error(`[setMyCommands] skipping "${name}" (description >256 chars).`);
      continue;
    }
    commands.push({ command: name, description: entry.description });
  }
  if (commands.length === 0) return { ok: false, reason: 'no commands' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands }),
    });
    const data = await res.json();
    if (data.ok) {
      console.log(`[setMyCommands] registered ${commands.length} commands`);
    } else {
      console.error(`[setMyCommands] failed:`, JSON.stringify(data));
    }
    return data;
  } catch (e) {
    console.error(`[setMyCommands] error:`, e.message);
    return { ok: false, error: e.message };
  }
}

let bootRegistered = false;
export async function ensureCommandsRegisteredOnce(env) {
  if (bootRegistered) return;
  bootRegistered = true;
  const audience = env.SESSION_NAMESPACE === 'recruiter' ? 'recruiter' : 'default';
  await registerBotCommands(env.BOT_TOKEN, { audience });
}

// Read what Telegram currently has registered (debug/verification only — not
// used in hot path). Returns {ok, commands[]} on success, {ok:false, error} on
// failure. Useful to prove that setMyCommands actually reached Telegram.
export async function getRegisteredCommands(token) {
  if (!token) return { ok: false, reason: 'no token' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMyCommands`);
    const data = await res.json();
    return data;
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function sendMessage(token, chatId, text, extra = {}) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', ...extra }),
  });
  const data = await res.json();
  if (!data.ok) {
    // Surface Telegram rejections — silent swallow here is how /start went dark
    // when a raw "<id>" slipped into commands-registry.json (cmdStart's HTML
    // message was 400-rejected and the user saw "ноль реакции"). Caller still
    // gets `data` back so existing flows don't break; we just log it loudly.
    console.error(`[sendMessage] chat=${chatId} failed:`, JSON.stringify(data));
  }
  return data;
}

export async function editMessage(token, chatId, messageId, text, extra = {}) {
  const { lifecycleEnv, ...telegramExtra } = extra;
  const res = await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', ...telegramExtra }),
  });
  const result = await res.json();
  if (result.ok && lifecycleEnv) {
    const keyboard = telegramExtra.reply_markup?.inline_keyboard;
    if (keyboard?.length) await trackUI(lifecycleEnv, chatId, messageId, keyboard, result.result?.date ? result.result.date * 1000 : Date.now());
    else if (keyboard) await forgetUI(lifecycleEnv, chatId, messageId);
  }
  return result;
}

export async function editMessageReplyMarkup(token, chatId, messageId, inlineKeyboard = []) {
  const res = await fetch(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: inlineKeyboard } }),
  });
  return res.json();
}

export async function sendMessageWithKeyboard(token, chatId, text, inlineKeyboard, extra = {}, lifecycleEnv) {
  const result = await sendMessage(token, chatId, text, {
    reply_markup: { inline_keyboard: inlineKeyboard },
    ...extra,
  });
  if (result.ok) await trackUI(lifecycleEnv, chatId, result.result?.message_id, inlineKeyboard, result.result?.date ? result.result.date * 1000 : Date.now());
  return result;
}

export async function answerCallbackQuery(token, callbackQueryId, text = '') {
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}

export async function pinChatMessage(token, chatId, messageId, { silent = false } = {}) {
  const res = await fetch(`https://api.telegram.org/bot${token}/pinChatMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, disable_notification: silent }),
  });
  const data = await res.json();
  if (!data.ok) console.error(`[pin] failed chat=${chatId} msg=${messageId}:`, JSON.stringify(data));
  else console.log(`[pin] ok chat=${chatId} msg=${messageId} silent=${silent}`);
}

export async function unpinChatMessage(token, chatId, messageId) {
  await fetch(`https://api.telegram.org/bot${token}/unpinChatMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
  });
}

export async function deleteMessage(token, chatId, messageId) {
  await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
  });
}


export async function sendDocument(token, chatId, filename, content, caption = '') {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('document', new Blob([content], { type: 'text/plain' }), filename);
  if (caption) form.append('caption', caption);
  const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
    method: 'POST',
    body: form,
  });
  return res.json();
}
