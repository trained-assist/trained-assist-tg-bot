import { Hono } from 'hono';
import { handleMessage } from './handlers/message.js';
import { handleCommand } from './handlers/commands.js';
import { handleUserMgmt, isUserMgmtCommand } from './handlers/user-mgmt.js';
import { handleCallbackQuery } from './handlers/callbacks.js';
import { getSession } from './lib/kv.js';

const app = new Hono();

// Health check
app.get('/health', (c) => c.json({ status: 'alive' }));

// Telegram webhook
app.post('/webhook', async (c) => {
  const env = c.env;
  let update;
  try {
    update = await c.req.json();
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }

  // Fire-and-forget — Telegram expects 200 within 5s
  c.executionCtx.waitUntil(dispatch(update, env));
  return c.json({ ok: true });
});

async function dispatch(update, env) {
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query, env);
    return;
  }

  const msg = update.message;
  if (!msg) return;

  // Invalidate member count cache when group membership changes
  if (msg.new_chat_members || msg.left_chat_member) {
    await env.SESSIONS.delete(`mc:${msg.chat.id}`);
    return;
  }

  const chatId = msg.chat.id;
  const text = msg.text || '';
  const isGroup = ['group', 'supergroup'].includes(msg.chat.type);

  // Admin group: only user-mgmt commands pass through
  if (String(chatId) === env.ADMIN_GROUP_ID) {
    if (isUserMgmtCommand(text)) await handleUserMgmt(msg, env);
    return;
  }

  // Other groups: commands and mentions/replies always handled;
  // regular messages handled based on group size
  if (isGroup) {
    const isMentioned = text.includes(`@${env.BOT_USERNAME}`);
    const isReplyToBot = msg.reply_to_message?.from?.username === env.BOT_USERNAME;
    const isAddressedToBot = isMentioned || isReplyToBot;
    const isCommand = text.startsWith('/');
    const hasContent = !!(msg.voice || msg.audio || msg.document || msg.photo || text);
    console.log(`[group ${chatId}] ${msg.from?.username || msg.from?.id}: ${text.slice(0, 100)}`);

    if (!isCommand && !isAddressedToBot) {
      // Skip if no content, or no active session in this chat
      if (!hasContent) return;
      const session = await getSession(env.SESSIONS, chatId);
      if (!session) return;
      // In groups with 3+ members require explicit mention or reply
      const memberCount = await getGroupMemberCount(env, chatId);
      if (memberCount > 2) return;
    }

    // Strip mention from text before handling
    const cleanText = text.replace(new RegExp(`@${env.BOT_USERNAME}`, 'g'), '').trim();
    const cleanMsg = { ...msg, text: cleanText };
    if (isCommand) await handleCommand(cleanMsg, env);
    else await handleMessage(cleanMsg, env);
    return;
  }

  // Private chat: commands vs messages
  if (text.startsWith('/')) {
    await handleCommand(msg, env);
  } else {
    await handleMessage(msg, env);
  }
}

/** Returns cached Telegram chat member count (TTL 1h). Fails safe to 999. */
async function getGroupMemberCount(env, chatId) {
  const cacheKey = `mc:${chatId}`;
  try {
    const cached = await env.SESSIONS.get(cacheKey, { type: 'json' });
    if (cached && Date.now() - cached.ts < 60 * 60 * 1000) return cached.count;

    const res = await fetch(
      `https://api.telegram.org/bot${env.BOT_TOKEN}/getChatMemberCount?chat_id=${chatId}`
    );
    const data = await res.json();
    if (data.ok) {
      await env.SESSIONS.put(cacheKey, JSON.stringify({ count: data.result, ts: Date.now() }));
      return data.result;
    }
  } catch { /* ignore */ }
  return 999; // fail-safe: treat as large group
}

export default app;
