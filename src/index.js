import { Hono } from 'hono';
import { handleMessage } from './handlers/message.js';
import { handleCommand, isAdminForwardedCommand } from './handlers/commands.js';
import { handleUserMgmt, isUserMgmtCommand } from './handlers/user-mgmt.js';
import { handleCallbackQuery } from './handlers/callbacks.js';
import { getSession, getOrCreateMappedSession } from './lib/kv.js';
import { sendMessage } from './lib/telegram.js';

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
  const chatId = update?.message?.chat?.id ?? update?.callback_query?.message?.chat?.id;
  try {
    await dispatchInner(update, env);
  } catch (err) {
    console.error(`[dispatch] unhandled error chatId=${chatId}:`, err?.message, err?.stack);
    if (chatId) {
      try {
        await sendMessage(env.BOT_TOKEN, chatId, `❌ Внутренняя ошибка: ${err?.message || err}`);
      } catch { /* ignore */ }
    }
  }
}

async function dispatchInner(update, env) {
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query, env);
    return;
  }

  const msg = update.message;
  if (!msg) return;

  // Skip stale messages — delivered >5 min late means worker was down during that time
  const msgAge = Math.round(Date.now() / 1000 - msg.date);
  if (msgAge > 300) {
    const isPrivate = msg.chat.type === 'private';
    const isCommand = (msg.text || '').startsWith('/');
    // Notify user for semi-old messages (5–30 min), silently drop very old ones
    if (isPrivate && !isCommand && msgAge < 1800) {
      await sendMessage(env.BOT_TOKEN, msg.chat.id,
        `📬 Сообщение получено с задержкой ${Math.round(msgAge / 60)} мин — отправь снова если актуально.`
      );
    }
    return;
  }

  // Invalidate member count cache when group membership changes
  if (msg.new_chat_members || msg.left_chat_member) {
    await env.SESSIONS.delete(`mc:${msg.chat.id}`);
    return;
  }

  const chatId = msg.chat.id;
  const text = msg.text || '';
  const isGroup = ['group', 'supergroup'].includes(msg.chat.type);

  // Admin group: user-mgmt commands + admin-only agent commands (e.g. /get_webpass)
  // pass through. Everything else is intentionally dropped to keep the group quiet.
  if (String(chatId) === env.ADMIN_GROUP_ID) {
    if (isUserMgmtCommand(text)) {
      await handleUserMgmt(msg, env);
    } else if (isAdminForwardedCommand(text)) {
      // Strip the bot mention so the agent sees a clean "/get_webpass <username>".
      const cleanText = text.replace(new RegExp(`@${env.BOT_USERNAME}`, 'g'), '').trim();
      await handleCommand({ ...msg, text: cleanText }, env);
    }
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
      if (!hasContent) return;
      // Use getOrCreateMappedSession so CHAT_MAPPINGS groups auto-create their session here
      const session = await getOrCreateMappedSession(env.SESSIONS, chatId, env, msg.from?.id);
      const isVoiceOrAudio = !!(msg.voice || msg.audio);
      // Voice bypasses member-count check only when allMsgMode was NEVER set.
      // If it was explicitly turned off (=== false), voice also obeys the limit.
      if (!session?.allMsgMode && (!isVoiceOrAudio || session?.allMsgMode === false)) {
        const memberCount = await getGroupMemberCount(env, chatId);
        console.log(`[group ${chatId}] memberCount=${memberCount} session=${!!session} allMsgMode=${session?.allMsgMode}`);
        if (memberCount > 2) {
          if (!session) console.log(`[group ${chatId}] large group, no session — skipping`);
          return;
        }
      }
      if (!session) {
        // 2-member group or voice/audio but no session and no CHAT_MAPPINGS — let handleMessage respond
        console.log(`[group ${chatId}] no session, passing to handleMessage`);
      }
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
  } else if (shouldDebounce(msg, env)) {
    // Intake accumulator: always buffer plain-text messages per chat; the user
    // launches the run explicitly (▶️ Запустить button, or a force word). Bypassed
    // for commands, replies-to-bot (answering a question) and non-text.
    const flush = FORCE_RUN_RE.test(msg.text); // "запускай/го" → run buffer now
    const stub = env.INTAKE.get(env.INTAKE.idFromName(String(chatId)));
    await stub.fetch('https://intake/append', {
      method: 'POST',
      body: JSON.stringify({ text: msg.text, msg, flush }),
    });
  } else {
    await handleMessage(msg, env);
  }
}

// A message that is ONLY an explicit launch word flushes the buffer immediately;
// otherwise launch is by the ▶️ button (§A #530: «запуск только по явной кнопке»).
// Must be a standalone word — the old broad regex matched prose like «давай сделаем…»
// and «…го…», firing the brain on the first message (the «стартует сразу» bug).
const FORCE_RUN_RE = /^\s*(запускай|запусти|поехали|го|go|run|начинай)\s*[!.]*\s*$/i;

/** True when a private message should be routed through the intake accumulator. */
function shouldDebounce(msg, env) {
  if (env.INTAKE_DEBOUNCE === 'off') return false; // kill-switch; default ON
  if (!env.INTAKE) return false;                   // binding missing → fail open
  const text = msg.text;
  if (!text) return false;                         // voice/photo/doc bypass (v1)
  if (text.startsWith('/')) return false;          // commands bypass
  if (msg.reply_to_message) return false;          // answering the bot bypasses
  return true;
}

/** Returns cached Telegram chat member count (TTL 1h). Falls back to stale cache, then 999. */
async function getGroupMemberCount(env, chatId) {
  const cacheKey = `mc:${chatId}`;
  let stale = null;
  try {
    const cached = await env.SESSIONS.get(cacheKey, { type: 'json' });
    if (cached) {
      if (Date.now() - cached.ts < 60 * 60 * 1000) return cached.count; // fresh
      stale = cached.count; // keep as fallback
    }

    const res = await fetch(
      `https://api.telegram.org/bot${env.BOT_TOKEN}/getChatMemberCount?chat_id=${chatId}`
    );
    const data = await res.json();
    if (data.ok) {
      await env.SESSIONS.put(cacheKey, JSON.stringify({ count: data.result, ts: Date.now() }));
      return data.result;
    }
    console.log(`[group ${chatId}] getChatMemberCount failed: ${JSON.stringify(data)}`);
  } catch (e) {
    console.log(`[group ${chatId}] getChatMemberCount error: ${e.message}`);
  }
  // Prefer stale cache over fail-safe — a known small group shouldn't be blocked by a transient error
  return stale ?? 999;
}

export { IntakeBuffer } from './intake-buffer.js';
export default app;
