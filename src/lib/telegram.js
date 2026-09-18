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
// Telegram limits: 100 commands/scope, 30 setMyCommands/min. Per-isolate call
// is fine even under burst cold-start; if many isolates race, Telegram returns
// 429 and we silently log — next boot retries.
export async function registerBotCommands(token) {
  if (!token) return { ok: false, reason: 'no token' };
  const seen = new Set();
  const commands = [];
  for (const entry of commandsRegistry.commands) {
    if (entry.hidden || entry.adminOnly) continue;
    if (seen.has(entry.command)) continue;
    seen.add(entry.command);
    const name = entry.command.replace(/^\//, '');
    // Telegram rejects the whole batch if any single command >32 chars.
    // Skip oversize entries with a loud log rather than failing the whole menu.
    if (name.length > 32) {
      console.error(`[setMyCommands] skipping "${name}" (${name.length} chars, Telegram limit is 32). Rename or hide via hidden:true.`);
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
  await registerBotCommands(env.BOT_TOKEN);
}

export async function sendMessage(token, chatId, text, extra = {}) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', ...extra }),
  });
  return res.json();
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
