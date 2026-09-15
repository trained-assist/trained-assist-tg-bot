// Telegram Bot API helpers

export async function sendMessage(token, chatId, text, extra = {}) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', ...extra }),
  });
  return res.json();
}

export async function editMessage(token, chatId, messageId, text, extra = {}) {
  const res = await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', ...extra }),
  });
  return res.json();
}

export async function editMessageReplyMarkup(token, chatId, messageId, inlineKeyboard = []) {
  const res = await fetch(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: inlineKeyboard } }),
  });
  return res.json();
}

export async function sendMessageWithKeyboard(token, chatId, text, inlineKeyboard, extra = {}) {
  return sendMessage(token, chatId, text, {
    reply_markup: { inline_keyboard: inlineKeyboard },
    ...extra,
  });
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
