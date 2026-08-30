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

  const chatId = msg.chat.id;
  const text = msg.text || '';
  const isGroup = ['group', 'supergroup'].includes(msg.chat.type);

  // Admin group: only user-mgmt commands pass through
  if (String(chatId) === env.ADMIN_GROUP_ID) {
    if (isUserMgmtCommand(text)) await handleUserMgmt(msg, env);
    return;
  }

  // Other groups: commands and mentions always handled;
  // regular messages/voice handled if user has an active session (logged in)
  if (isGroup) {
    const mentioned = text.includes(`@${env.BOT_USERNAME}`);
    const isCommand = text.startsWith('/');
    const hasContent = !!(msg.voice || msg.audio || msg.document || msg.photo || text);
    console.log(`[group ${chatId}] ${msg.from?.username || msg.from?.id}: ${text.slice(0, 100)}`);

    if (!isCommand && !mentioned) {
      // Skip if no content, or no active session in this chat
      if (!hasContent) return;
      const session = await getSession(env.SESSIONS, chatId);
      if (!session) return;
    }

    // Strip mention from text before handling
    const cleanText = text.replace(`@${env.BOT_USERNAME}`, '').trim();
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

export default app;
