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

  // Admin group: only user-mgmt commands pass through
  if (String(chatId) === env.ADMIN_GROUP_ID) {
    if (isUserMgmtCommand(text)) await handleUserMgmt(msg, env);
    return;
  }

  // Personal chat: commands vs messages
  if (text.startsWith('/')) {
    await handleCommand(msg, env);
  } else {
    await handleMessage(msg, env);
  }
}

export default app;
