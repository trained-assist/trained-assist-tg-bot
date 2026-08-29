import { Hono } from 'hono';
import { handleMessage } from './handlers/message.js';
import { handleCommand } from './handlers/commands.js';
import { handleUserMgmt, isUserMgmtCommand } from './handlers/user-mgmt.js';

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

  // Other groups: log silently, respond only on mention or command
  if (isGroup) {
    const mentioned = text.includes(`@${env.BOT_USERNAME}`);
    const isCommand = text.startsWith('/');
    console.log(`[group ${chatId}] ${msg.from?.username || msg.from?.id}: ${text.slice(0, 100)}`);
    if (!mentioned && !isCommand) return;
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
