import { serveMedia } from './media-jobs.js';
import { processExpiredUI } from './lib/transient-ui.js';
import { Hono } from 'hono';
import { handleMessage, processDueRetries } from './handlers/message.js';
import { handleCommand, isAdminForwardedCommand } from './handlers/commands.js';
import { handleUserMgmt, isUserMgmtCommand } from './handlers/user-mgmt.js';
import { handleCallbackQuery } from './handlers/callbacks.js';
import { getSession } from './lib/kv.js';
import { sendMessage, ensureCommandsRegisteredOnce, getRegisteredCommands } from './lib/telegram.js';
import { shouldDebounce, shouldAskProject, FORCE_RUN_RE, AUTO_LAUNCH_RE } from './intake-routing.js';
import { isAddressedToBot, hasContent, shouldHandleAmbient, stripBotMention, botWasAddedToGroup, groupWelcomeText } from './group-routing.js';
import { getProjectDecision } from './lib/agent-client.js';
import { openProjectChoice } from './lib/project-choice.js';

const app = new Hono();

// Preview deployments have no Telegram credentials or webhook ownership.
// Reject ingress before touching even the dedicated staging KV bindings.
app.use('*', async (c, next) => {
  if (c.env.PREVIEW_ONLY === 'true' && c.req.path !== '/health') return c.json({ error: 'preview only' }, 403);
  return next();
});
app.get('/internal/media', c => serveMedia(c.req.raw, c.env));

// Health check
app.get('/health', (c) => c.json({ status: 'alive', buildSha: c.env.BUILD_SHA || null }));

// Debug: dump what Telegram currently has registered as the bot's command
// menu. Used to verify that commands-registry.json → setMyCommands actually
// reached the Bot API. Returns {ok, count, commands[]} on success.
app.get('/debug/commands', async (c) => {
  const data = await getRegisteredCommands(c.env.BOT_TOKEN);
  if (!data.ok) return c.json(data, 500);
  return c.json({ ok: true, count: data.result.length, commands: data.result });
});

// Debug: dump what URL Telegram is currently posting updates to for this
// bot. Lets us verify that the Telegram webhook is actually pointed at the
// worker URL we expect (e.g. trained-assist-tg-bot-recruiter.skillset-apply.workers.dev
// for @super_recruiter_assistant_bot — not at the default worker, which would
// silently route the bot's updates to the wrong token/handler).
app.get('/debug/webhook', async (c) => {
  const token = c.env.BOT_TOKEN;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
    const data = await res.json();
    if (!data.ok) return c.json(data, 500);
    return c.json({ ok: true, webhook: data.result });
  } catch (e) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// Debug: dump the bot's identity (id, username, first_name) so a quick
// /debug/whoami tells us whose token the worker is actually wired to.
app.get('/debug/whoami', async (c) => {
  const token = c.env.BOT_TOKEN;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await res.json();
    if (!data.ok) return c.json(data, 500);
    return c.json({ ok: true, bot: data.result });
  } catch (e) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

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
  // Register the Telegram command menu once per isolate (commands-registry.json
  // is the single source of truth — see lib/telegram.js#registerBotCommands).
  c.executionCtx.waitUntil(ensureCommandsRegisteredOnce(env));
  return c.json({ ok: true });
});

// Prefix all SESSIONS KV keys so per-profile bots (recruiter, sales) can share
// the same KV namespace without inheriting each other's login sessions.
// Main bot omits SESSION_NAMESPACE → raw chatId keys (backward-compatible).
function applySessionNamespace(env) {
  if (!env.SESSION_NAMESPACE) return env;
  const ns = env.SESSION_NAMESPACE;
  const raw = env.SESSIONS;
  return { ...env, SESSIONS: {
    get: k => raw.get(`${ns}:${k}`),
    put: (k, v, opts) => raw.put(`${ns}:${k}`, v, opts),
    delete: k => raw.delete(`${ns}:${k}`),
    list: opts => raw.list(opts),
  }};
}

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

export async function dispatchInner(update, env) {
  env = applySessionNamespace(env);
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

  // Membership changed → the cached member count is stale.
  if (msg.new_chat_members || msg.left_chat_member) {
    await env.SESSIONS.delete(`mc:${msg.chat.id}`);
    // If WE were just added, don't sit silent (the "ноль реакции, старт только
    // реплаем" complaint) — greet and spell out how to talk to the bot here.
    if (botWasAddedToGroup(msg, env.BOT_USERNAME)) {
      await sendMessage(env.BOT_TOKEN, msg.chat.id, groupWelcomeText(env.BOT_USERNAME));
    }
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
    } else if (isAdminForwardedCommand(text) || /^\/restart(?:@\w+)?(?:\s|$)/i.test(text)) {
      // Strip the bot mention so the agent sees a clean "/get_webpass <username>".
      const cleanText = text.replace(new RegExp(`@${env.BOT_USERNAME}`, 'g'), '').trim();
      await handleCommand({ ...msg, text: cleanText }, env);
    }
    return;
  }

  // Other groups. Trigger rule lives in src/group-routing.js (pure + tested);
  // see docs/GROUP-TRIGGER-MATRIX.md. Summary:
  //   • /command                       → handle it
  //   • addressed (mention text/caption OR reply-to-bot) → same intake as private chats
  //   • ambient + (2-member group OR all-msg mode) → intake accumulator (▶️ launch)
  //   • ambient in a bigger group with all-msg off → ignore (text AND audio alike)
  if (isGroup) {
    const cleanText = stripBotMention(text, env.BOT_USERNAME);
    const cleanMsg = { ...msg, text: cleanText };
    console.log(`[group ${chatId}] ${msg.from?.username || msg.from?.id}: ${text.slice(0, 100)}`);

    if (text.startsWith('/')) {
      await handleCommand(cleanMsg, env);
      return;
    }
    // Addressing selects the recipient; it does not request an immediate launch.
    // Use the same intake path as private chats so follow-up media can be added.
    if (isAddressedToBot(msg, env.BOT_USERNAME)) {
      await routeText(cleanMsg, env, chatId);
      return;
    }
    if (!hasContent(msg)) return;

    // Ambient message: react only in a de-facto 1-on-1 (≤2 members) or when the
    // group opted into all-messages mode. Voice/audio obeys the SAME gate as text
    // (the old voice-only bypass answered audio in large groups — bug #4).
    const session = await getSession(env.SESSIONS, chatId);
    // Uniform model: a group accumulates every ambient message only when it opted in
    // via allMsgMode — which /login auto-enables for groups (commands.js cmdLogin) and
    // /all_on toggles. No CHAT_MAPPINGS special-case: every chat, mapped or not, logs
    // in the same way and follows the same allMsgMode flag persisted in its session.
    const allMsgMode = session?.allMsgMode;
    const memberCount = allMsgMode ? undefined : await getGroupMemberCount(env, chatId);
    console.log(`[group ${chatId}] ambient memberCount=${memberCount} allMsgMode=${allMsgMode}`);
    if (!shouldHandleAmbient({ allMsgMode, memberCount })) return;

    // Same intake accumulator as private chats — a 2-member group is a 1-on-1
    // workflow and buffers + launches by ▶️, not a session per quick message (#530).
    await routeText(cleanMsg, env, chatId);
    return;
  }

  // Private chat: commands vs messages. Service-only updates (pin notifications,
  // etc.) carry no text/voice/photo/document — same gate the group branch already
  // uses (hasContent) — so they're silently dropped instead of hitting the
  // "не могу обработать этот тип сообщения" fallback in handleMessage.
  if (text.startsWith('/')) {
    await handleCommand(msg, env);
  } else if (!hasContent(msg)) {
    return;
  } else {
    await routeText(msg, env, chatId);
  }
}

// One text-routing rule for both private and group chats: buffer through the
// intake accumulator (explicit launch by ▶️ button or force word), else pass
// straight to the agent. Keeping this in one place is why the group path can't
// silently drift from the private path again (#530).
export async function routeText(msg, env, chatId) {
  if (shouldDebounce(msg, env)) {
    // Pin replies AND an explicitly chosen new project at receipt, so switching
    // menus before launch cannot move an already collected batch to another project.
    const session = await getSession(env.SESSIONS, chatId);
    const sessionId = session?.activeSessionId || session?.lastSessionId;

    // Show the project picker immediately for new sessions with multiple projects,
    // instead of waiting for the user to press ▶️ and the debounce to expire.
    // This restores the pre-debounce UX where the picker appeared right after the first message.
    if (!sessionId && session && !session.pendingProjectChoice) {
      try {
        const decision = await getProjectDecision(env, { username: session.username, chatId });
        if (shouldAskProject({ isNewDialog: true, decision })) {
          await openProjectChoice(env, chatId, session, { decision, input: msg });
          return;
        }
      } catch { /* fail open — fall through to normal debounce path */ }
    }

    if (msg.reply_to_message || (sessionId && session?.projectSelectionSessionId === sessionId)) {
      if (sessionId) msg = { ...msg, intakeRoute: { sessionId,
        forceNew: !!(session.activeSessionId && session.activeSessionIsNew),
        projectId: session.projectId || null,
        projectChosen: session.projectSelectionSessionId === sessionId,
        newProject: !!session.pendingNewProject, contextFromSession: session.contextFromSession || null } };
    }
    // FORCE_RUN_RE: explicit launch words ("запускай/го") when buffer may have content.
    // AUTO_LAUNCH_RE: clear continuation signals ("продолжай/ок") — treated the same:
    // dispatch the buffer (or just this one message if buffer was empty) immediately.
    const flush = FORCE_RUN_RE.test(msg.text || '') || AUTO_LAUNCH_RE.test(msg.text || '');
    const stub = env.INTAKE.get(env.INTAKE.idFromName(String(chatId)));
    await stub.fetch(env.AGENT_URL && env.SESSIONS && !flush ? 'https://intake/ingest' : 'https://intake/append', {
      method: 'POST',
      body: JSON.stringify({ text: msg.text, msg, flush }),
    });
  } else {
    await handleMessage(msg, env);
  }
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

// Class B self-heal (issue #604): drains the KV retry queue every ~1min via
// the Cron Trigger declared in wrangler.toml. waitUntil keeps the invocation
// alive past the return — scheduled handlers have no separate "response" to wait on.
async function scheduled(event, env, ctx) {
  if (env.PREVIEW_ONLY === 'true') return;
  ctx.waitUntil(processDueRetries(env));
  ctx.waitUntil(processExpiredUI(env));
}

export { RunOutbox } from './run-outbox.js';
export { IntakeBuffer } from './intake-buffer.js';
export default { fetch: app.fetch, scheduled };

export { RetryQueue } from './retry-queue.js';

export { MediaJob } from './media-jobs.js';
