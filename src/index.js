import { serveMedia } from './media-jobs.js';
import { transcribeAudio } from './lib/speech.js';
import { resolveBotContext, envForBot } from './lib/bot-context.js';
import { processExpiredUI } from './lib/transient-ui.js';
import { Hono } from 'hono';
import { handleMessage, processDueRetries } from './handlers/message.js';
import { handleCommand, isAdminForwardedCommand } from './handlers/commands.js';
import { handleUserMgmt, isUserMgmtCommand } from './handlers/user-mgmt.js';
import { handleCallbackQuery } from './handlers/callbacks.js';
import { getSession } from './lib/kv.js';
import { isAdminGroupChat, isAdminOnlyCommand, isAdminLocalCommand, adminOnlyHint } from './lib/admin-group.js';
import { initTestMode, isTestChat, realChatId, rememberCallback } from './lib/test-mode.js';
import { sendMessage, sendMessageWithKeyboard, ensureCommandsRegisteredOnce, getRegisteredCommands } from './lib/telegram.js';
import { conversationKey, threadExtra, threadIdOf } from './conversation-context.js';
import { recordGroupMessage } from './group-history.js';
import { shouldDebounce, shouldAskProject, hasIntakeContent, FORCE_RUN_RE, AUTO_LAUNCH_RE } from './intake-routing.js';
import { isAddressedToBot, hasContent, shouldHandleAmbient, stripBotMention, botWasAddedToGroup, groupWelcomeText, noContentNudgeText } from './group-routing.js';
import { getProjectDecision } from './lib/agent-client.js';
import { openProjectChoice } from './lib/project-choice.js';
import { chatConfigCommandFromPhrase } from './lib/project-command.js';
import { captureSupplement, cancelSupplement, showSupplementConfirm } from './lib/supplement.js';
import { applySessionNamespace } from './lib/session-namespace.js';
import { isConnectCommand, dispatchConnect } from './lib/connected-app-bootstrap.js';

const app = new Hono();

// Preview deployments have no Telegram credentials or webhook ownership.
// Reject ingress before touching even the dedicated staging KV bindings.
app.use('*', async (c, next) => {
  if (c.env.PREVIEW_ONLY === 'true' && c.req.path !== '/health') return c.json({ error: 'preview only' }, 403);
  return next();
});
app.get('/internal/media', c => serveMedia(c.req.raw, c.env));

// Agent → gateway: run settled (epic #1527 PR1). The IntakeBuffer holds `busy`
// for the REAL lifetime of a run; this is the primary release signal (the
// agent also exposes GET /tasks/running?chatId= as the alarm-poll safety net).
// Bearer AGENT_SECRET — same auth as every other agent→gateway/internal route.
app.post('/internal/run-finished', async c => {
  if (!c.env.AGENT_SECRET || c.req.header('Authorization') !== `Bearer ${c.env.AGENT_SECRET}`) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const body = await c.req.json().catch(() => null);
  const chatId = Number(body?.chatId);
  // 0 is the web/internal sentinel; real Telegram chats include NEGATIVE
  // group/supergroup ids, which must reach their IntakeBuffer.
  if (!Number.isSafeInteger(chatId) || chatId === 0) return c.json({ error: 'invalid chatId' }, 400);
  const rawThread = body?.threadId;
  const threadId = rawThread == null ? null : Number(rawThread);
  if (threadId != null && (!Number.isSafeInteger(threadId) || threadId <= 0)) return c.json({ error: 'invalid threadId' }, 400);
  const requestId = typeof body?.requestId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(body.requestId) ? body.requestId : null;
  // Message ids the model already took in mid-run via get_new_messages (live inbox).
  const consumed = Array.isArray(body?.consumed) ? body.consumed.map(Number).filter(Number.isSafeInteger).slice(0, 200) : [];
  // Test mode (DESIGN §2.1/§2.2): the run went out under a reserve chatId —
  // translate back BEFORE choosing the IntakeBuffer, or `busy` never releases.
  // Journal lines: run-finished when this is a test chat, agent-answer whenever
  // the agent returned its answer (contract: only sent with delivery:"log").
  const realChat = realChatId(c.env, chatId);
  const answer = typeof body?.answer === 'string' && body.answer ? body.answer.slice(0, 8000) : null;
  const outcome = ['done', 'error', 'stopped', 'quick'].includes(body?.outcome) ? body.outcome : null;
  if (isTestChat(c.env, realChat) && outcome) {
    console.log(`[test-mode] kind=run-finished chat=${realChat} requestId=${requestId || '-'} outcome=${outcome}`);
  }
  if (answer != null) {
    console.log(`[test-mode] kind=agent-answer chat=${realChat} requestId=${requestId || '-'} len=${answer.length} text=${answer.slice(0, 4000)}`);
  }
  const stub = c.env.INTAKE.get(c.env.INTAKE.idFromName(conversationKey(realChat, threadId)));
  const res = await stub.fetch('https://intake/run-finished', {
    method: 'POST',
    body: JSON.stringify(consumed.length ? { requestId, consumed } : { requestId }),
  });
  const payload = await res.json().catch(() => ({}));
  return c.json(payload, res.status);
});

/** Отметка отправленного сообщения для /clean_up_flood (та же схема, что у буфера). */
async function recordGatewaySent(env, chatId, messageId) {
  if (!env?.SESSIONS) return;
  try {
    const key = `sent:${chatId}`;
    const val = await env.SESSIONS.get(key);
    const ids = val ? JSON.parse(val) : [];
    if (!ids.includes(messageId)) ids.push(messageId);
    await env.SESSIONS.put(key, JSON.stringify(ids.slice(-300)), { expirationTtl: 3 * 24 * 60 * 60 });
  } catch (e) {
    console.error('[deliver] sent-record failed:', e.message);
  }
}

// Control plane → gateway: доставка сообщения в канал (архитектурная граница:
// outbox принадлежит control plane, канал/кнопка/обработчик запуска — шлюзу).
//
// Возвращаем providerMessageId ТОЛЬКО когда Telegram реально принял сообщение.
// Это единственное доказательство доставки: 200 без message_id означает, что
// control plane не должен считать доставку выполненной (arch#132, Приоритет 3b).
app.post('/deliver', async c => {
  if (!c.env.AGENT_SECRET || c.req.header('Authorization') !== `Bearer ${c.env.AGENT_SECRET}`) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const body = await c.req.json().catch(() => null);
  const deliveryId = typeof body?.deliveryId === 'string' ? body.deliveryId.slice(0, 128) : null;
  const channel = typeof body?.channel === 'string' ? body.channel : null;
  // Адрес доставки: для Telegram это chat id (в т.ч. отрицательный — группа).
  const rawDest = body?.destinationId;
  const chatId = Number(rawDest);
  if (!deliveryId) return c.json({ error: 'invalid deliveryId' }, 400);
  if (channel !== 'telegram') return c.json({ error: 'unsupported channel' }, 400, { channel });
  if (!Number.isSafeInteger(chatId) || chatId === 0) return c.json({ error: 'invalid destinationId' }, 400);

  const message = body?.message && typeof body.message === 'object' ? body.message : {};
  const kind = typeof message.kind === 'string' ? message.kind : 'text';
  const text = typeof message.text === 'string' && message.text ? message.text.slice(0, 4000) : null;
  if (!text) return c.json({ error: 'missing message text' }, 400);

  const threadId = Number.isInteger(Number(body?.threadId)) && Number(body?.threadId) > 0
    ? Number(body.threadId)
    : null;
  const extra = threadId ? { message_thread_id: threadId } : {};

  // Кнопка запуска: адресная. `intake_run` сливает буфер ЭТОГО чата, а проверка
  // актуальности и защита от второго запуска живут в нём же (пустой буфер → ответ
  // «нечего запускать», идущий ран → «уже идёт»), поэтому повторное нажатие или
  // гонка с начавшейся работой не создают второй запуск.
  // sendMessageWithKeyboard takes the ROWS ARRAY and wraps it into reply_markup
  // itself. Passing a pre-wrapped { inline_keyboard } double-wraps it and Telegram
  // rejects the send with «field "inline_keyboard" must be of type Array» —
  // found by the first live acceptance run of the C02.1 seam (2026-10-04).
  const keyboard = kind === 'stuck_input'
    ? [[{ text: '▶️ Запустить проработку', callback_data: 'intake_run' }]]
    : undefined;

  const result = await sendMessageWithKeyboard(c.env.BOT_TOKEN, chatId, text, keyboard, extra)
    .catch(async () => sendMessage(c.env.BOT_TOKEN, chatId, text, extra));

  const providerMessageId = result?.result?.message_id;
  if (!providerMessageId) {
    // Канал не принял: это НЕ доставка. Честный отказ, чтобы control plane
    // повторил, а не записал «успех».
    return c.json({ error: 'channel did not accept', description: result?.description || null }, 502);
  }
  await recordGatewaySent(c.env, chatId, providerMessageId);
  return c.json({ providerMessageId, kind, deliveryId });
});

// Agent → gateway: messages the user sent AFTER the current run started (live inbox,
// owner 2026-09-29). Backs the agent's MCP tool get_new_messages. Same auth and
// chat/thread validation as /internal/run-finished; `requestId` scopes the read to
// the run that holds this chat, so a sibling run can't read another run's input.
app.get('/internal/held-messages', async c => {
  if (!c.env.AGENT_SECRET || c.req.header('Authorization') !== `Bearer ${c.env.AGENT_SECRET}`) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const chatId = Number(c.req.query('chatId'));
  if (!Number.isSafeInteger(chatId) || chatId === 0) return c.json({ error: 'invalid chatId' }, 400);
  const rawThread = c.req.query('threadId');
  const threadId = rawThread == null || rawThread === '' ? null : Number(rawThread);
  if (threadId != null && (!Number.isSafeInteger(threadId) || threadId <= 0)) return c.json({ error: 'invalid threadId' }, 400);
  const rawReq = c.req.query('requestId');
  const requestId = rawReq && /^[a-zA-Z0-9_-]{1,128}$/.test(rawReq) ? rawReq : null;
  // Test mode: same reserve→real inversion as /internal/run-finished (§2.1).
  const realChat = realChatId(c.env, chatId);
  const stub = c.env.INTAKE.get(c.env.INTAKE.idFromName(conversationKey(realChat, threadId)));
  const res = await stub.fetch(`https://intake/held${requestId ? `?requestId=${encodeURIComponent(requestId)}` : ''}`);
  const payload = await res.json().catch(() => ({}));
  return c.json(payload, res.status);
});

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

// Debug: dump a chat's IntakeBuffer Durable Object state (buf/retryBatch/busy).
// Diagnoses "stuck forever" batches — a preparation failure that keeps
// re-throwing on every retry (non-transient cause) leaves its batch in
// `retryBatch`, which every future message re-attempts and re-fails.
// Gated on AGENT_SECRET since chat content (message ids, media refs) is
// otherwise exposed.
app.get('/debug/intake/:chatId', async (c) => {
  if (c.req.header('Authorization') !== `Bearer ${c.env.AGENT_SECRET}`) return c.json({ error: 'unauthorized' }, 401);
  const stub = c.env.INTAKE.get(c.env.INTAKE.idFromName(conversationKey(c.req.param('chatId'), Number(c.req.query('threadId')))));
  const res = await stub.fetch('https://intake/debug' + new URL(c.req.url).search);
  return new Response(res.body, { status: res.status, headers: res.headers });
});

// Explicit operational recovery; restoring never launches a task or sends messages.
app.post('/debug/intake/:chatId/restore', async c => {
  if (!c.env.AGENT_SECRET || c.req.header('Authorization') !== `Bearer ${c.env.AGENT_SECRET}`) return c.json({ error: 'unauthorized' }, 401);
  const stub = c.env.INTAKE.get(c.env.INTAKE.idFromName(conversationKey(c.req.param('chatId'), Number(c.req.query('threadId')))));
  return stub.fetch('https://intake/restore', { method: 'POST', body: await c.req.text() });
});

// Ops escape hatch for a batch that is buffered but will not auto-launch (no
// timer, no ▶️ tap available): flush it as if the button had been pressed —
// same /flush path, so a live run is never doubled (it queues instead). Added
// with #248: the live dead-end of 2026-09-29 was only fixable by a tap in chat.
app.post('/debug/intake/:chatId/flush', async c => {
  if (!c.env.AGENT_SECRET || c.req.header('Authorization') !== `Bearer ${c.env.AGENT_SECRET}`) return c.json({ error: 'unauthorized' }, 401);
  const stub = c.env.INTAKE.get(c.env.INTAKE.idFromName(conversationKey(c.req.param('chatId'), Number(c.req.query('threadId')))));
  const res = await stub.fetch('https://intake/flush', { method: 'POST' });
  return new Response(res.body, { status: res.status, headers: res.headers });
});

// Debug: POST raw audio bytes, get back what speech_transcribe returned (or the
// error). Isolates the transcription leg of transcribeVoice from Telegram getFile,
// so an "Не удалось подготовить вложение" report can be narrowed to a specific
// external call without needing a fresh file_id from the reporting chat. Added
// investigating a live report on chat 8815112204 / recruiter env, 2026-09-23.
// Gated on AGENT_SECRET since it spends the speech quota on arbitrary input.
//
// tg-bot#319: путь теперь шлюз → /intake-files → POST /action, а не напрямую в
// Deepgram. Профиль обязателен: /action работает от USER_ID, «универсального»
// профиля здесь быть не должно. X-Mime-Type больше не нужен — формат скил
// определяет сам (по расширению либо magic-байтам).
app.post('/debug/transcribe-test', async (c) => {
  if (c.req.header('Authorization') !== `Bearer ${c.env.AGENT_SECRET}`) return c.json({ error: 'unauthorized' }, 401);
  const username = c.req.query('username');
  if (!username || !/^[a-zA-Z0-9_-]{1,64}$/.test(username)) return c.json({ error: 'username required' }, 400);
  const audioBuffer = await c.req.arrayBuffer();
  const bytesSent = audioBuffer.byteLength;
  try {
    const result = await transcribeAudio(c.env, {
      username,
      bytes: audioBuffer,
      // Стабильный ключ: повторные вызовы перезаписывают один файл, а не плодят
      // новые записи в intake-store (диагностика зовётся часто и вручную).
      key: `debug:${username}`,
      name: 'debug-audio',
      mime: c.req.header('X-Mime-Type') || 'application/octet-stream',
    });
    return c.json({ ok: true, bytesSent, text: result.text, duration: result.duration, language: result.language });
  } catch (e) {
    return c.json({ ok: false, error: e.message, permanent: !!e.permanent, bytesSent }, e.permanent ? 422 : 500);
  }
});

// Telegram webhook. `/webhook` is the legacy per-env route; `/webhook/:botId`
// serves a bot from the BOTS registry (epic trained-assist-agent#1342, one Worker
// for N bots). Both share one handler; the bot comes from the transport only.
app.post('/webhook', (c) => handleWebhook(c, undefined));
app.post('/webhook/:botId', (c) => handleWebhook(c, c.req.param('botId')));

async function handleWebhook(c, pathBotId) {
  const secretHeader = c.req.header('X-Telegram-Bot-Api-Secret-Token');
  let bot;
  try {
    bot = resolveBotContext(c.env, { pathBotId, secretHeader });
  } catch (e) {
    console.error('[webhook] bad BOTS registry:', e.message);
    return c.json({ error: 'bot registry misconfigured' }, 500);
  }
  if (!bot) return c.json({ error: 'unknown bot' }, 404);
  // Per-bot webhook secret. Every bot sets it when calling setWebhook (secret_token);
  // Telegram then echoes it in X-Telegram-Bot-Api-Secret-Token on every delivery.
  // Validate BEFORE parsing the body or touching any state — an unsigned update
  // must never reach dispatch. FAIL CLOSED: a bot with no secret configured is
  // rejected too. The old "unset = accept" default let anyone POST a forged
  // update (any chat.id, incl. ADMIN_GROUP_ID) to main/recruiter (audit 2026-09-25).
  // Durable ACK is deliberately not implemented (issue #1302 §4.3).
  if (!bot.webhookSecret) {
    console.error('[webhook] TELEGRAM_WEBHOOK_SECRET not configured — rejecting update (fail closed)');
    return c.json({ error: 'webhook secret not configured' }, 401);
  }
  if (secretHeader !== bot.webhookSecret) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const env = envForBot(c.env, bot);
  let update;
  try {
    update = await c.req.json();
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }

  // The Telegram actor may be asserted only after this route's webhook secret gate.
  if (isConnectCommand(update?.message, env.BOT_USERNAME)) {
    if (env.CONNECTED_APP_TELEGRAM_CONNECT_ENABLED === 'true') {
      const botId = bot.botId || env.CONNECTED_APP_BOOTSTRAP_BOT_ID;
      c.executionCtx.waitUntil(dispatchConnect(update, env, botId));
    } else if (update.message.chat?.type === 'private' && Number.isSafeInteger(update.message.chat.id)) {
      c.executionCtx.waitUntil(sendMessage(env.BOT_TOKEN, update.message.chat.id, 'Веб-вход пока не включён.'));
    }
    return c.json({ ok: true });
  }

  // Fire-and-forget — Telegram expects 200 within 5s
  c.executionCtx.waitUntil(dispatch(update, env));
  // Register the Telegram command menu once per isolate (commands-registry.json
  // is the single source of truth — see lib/telegram.js#registerBotCommands).
  c.executionCtx.waitUntil(ensureCommandsRegisteredOnce(env));
  return c.json({ ok: true });
}

async function dispatch(update, env) {
  const source = update?.message ?? update?.callback_query?.message;
  const chatId = source?.chat?.id;
  const threadId = threadIdOf(source);
  try {
    await dispatchInner(update, env);
  } catch (err) {
    console.error(`[dispatch] unhandled error chatId=${chatId}:`, err?.message, err?.stack);
    if (chatId) {
      try {
        await sendMessage(env.BOT_TOKEN, chatId, `❌ Внутренняя ошибка: ${err?.message || err}`, threadExtra(threadId));
      } catch { /* ignore */ }
    }
  }
}

export async function dispatchInner(update, env) {
  env = applySessionNamespace(env);
  // Test mode init point #1 — every webhook update lands here before any send
  // (lib/telegram.js reads the module cache; see DESIGN §2.2).
  initTestMode(env);
  if (update.callback_query) {
    // answerCallbackQuery has no chat id — remember where this callback came
    // from so the ack can be gated (DESIGN §2.2, callback registry).
    rememberCallback(update.callback_query.id, update.callback_query.message?.chat?.id);
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
        `📬 Сообщение получено с задержкой ${Math.round(msgAge / 60)} мин — отправь снова если актуально.`,
        threadExtra(threadIdOf(msg))
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
      await sendMessage(env.BOT_TOKEN, msg.chat.id, groupWelcomeText(env.BOT_USERNAME), threadExtra(threadIdOf(msg)));
    }
    return;
  }

  const chatId = msg.chat.id;
  const text = msg.text || '';
  const isGroup = ['group', 'supergroup'].includes(msg.chat.type);

  // Admin group: user-mgmt commands + admin-only agent commands (e.g. /get_webpass)
  // pass through. Everything else is intentionally dropped to keep the group quiet.
  if (isAdminGroupChat(chatId, env.ADMIN_GROUP_ID)) {
    if (msg.migrate_to_chat_id) {
      console.error(`[admin] admin group ${chatId} migrated to supergroup ${msg.migrate_to_chat_id} — matched automatically; update ADMIN_GROUP_ID secret`);
      return;
    }
    if (isUserMgmtCommand(text)) {
      await handleUserMgmt(msg, env);
    } else if (isAdminForwardedCommand(text) || isAdminLocalCommand(text) || /^\/restart(?:@\w+)?(?:\s|$)/i.test(text)) {
      // Strip the bot mention so the agent sees a clean "/get_webpass <username>".
      const cleanText = text.replace(new RegExp(`@${env.BOT_USERNAME}`, 'g'), '').trim();
      await handleCommand({ ...msg, text: cleanText }, env);
    }
    return;
  }

  // Admin commands outside the admin chat: say why instead of the generic
  // "Неизвестная команда" — that message hid the supergroup-id drift above.
  if (isAdminOnlyCommand(stripBotMention(text, env.BOT_USERNAME))) {
    console.warn(`[admin] admin-only command from non-admin chat ${chatId} (ADMIN_GROUP_ID=${env.ADMIN_GROUP_ID || 'unset'})`);
    await sendMessage(env.BOT_TOKEN, chatId, adminOnlyHint(chatId), threadExtra(threadIdOf(msg)));
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
      await cancelSupplementForCommand(env, chatId, threadIdOf(msg));
      await handleCommand(cleanMsg, env);
      return;
    }
    // Addressing selects the recipient; it does not request an immediate launch.
    // Use the same intake path as private chats so follow-up media can be added.
    // A content-less addressed message (bare mention, reply-with-sticker/GIF)
    // must NOT reach the agent as an EMPTY task (that ended in a 400 "missing
    // fields" the outbox surfaced as «⚠️ Задача сохранена, но сервер отклонил
    // её (HTTP 400)»). But it must not be dropped in silence either — the owner
    // wants a friendly nudge so the person knows we're here (2026-09-27).
    // hasIntakeContent (not hasContent) so addressed video/photo still route: it
    // matches the media the intake pipeline actually processes. Clean text (bot
    // mention stripped) — a bare «@bot» mention has no actable content either.
    if (isAddressedToBot(msg, env.BOT_USERNAME)) {
      if (hasIntakeContent(cleanMsg)) {
        await routeText(cleanMsg, env, chatId);
      } else {
        await sendMessage(env.BOT_TOKEN, chatId, noContentNudgeText(), threadExtra(threadIdOf(msg)));
      }
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
    if (!shouldHandleAmbient({ allMsgMode, memberCount })) {
      // Quiet mode: don't act, but remember it so a later «@bot …» task sees what the
      // group discussed (src/group-history.js). Logged-in groups only.
      if (session) await recordGroupMessage(env, msg, threadIdOf(msg));
      return;
    }

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
    await cancelSupplementForCommand(env, chatId, threadIdOf(msg));
    await handleCommand(msg, env);
  } else if (!hasContent(msg)) {
    return;
  } else {
    await routeText(msg, env, chatId);
  }
}

// A command while «➕ Дополнить» waits for text drops the draft (SS-09): the user
// moved on, so the running task stays untouched and anything already typed goes
// back to the normal intake flow instead of vanishing.
async function cancelSupplementForCommand(env, chatId, threadId) {
  const dropped = await cancelSupplement(env, chatId, threadId);
  if (!dropped) return;
  await sendMessage(env.BOT_TOKEN, chatId, dropped.items?.length
    ? '✖️ Дополнение отменено — задача продолжает работать. Написанное вернул во входящие.'
    : '✖️ Дополнение отменено — задача продолжает работать.', threadExtra(threadId)).catch(() => {});
}

// One text-routing rule for both private and group chats: buffer through the
// intake accumulator (explicit launch by ▶️ button or force word), else pass
// straight to the agent. Keeping this in one place is why the group path can't
// silently drift from the private path again (#530).
export async function routeText(msg, env, chatId) {
  const threadId = threadIdOf(msg);
  // «текущий проект» / «закрепи X» / «сними закрепление» / «покажи настройки» → the command.
  const configCmd = chatConfigCommandFromPhrase(msg.text);
  if (configCmd) {
    await handleCommand({ ...msg, text: configCmd }, env);
    return;
  }
  if (shouldDebounce(msg, env)) {
    // Pin replies AND an explicitly chosen new project at receipt, so switching
    // menus before launch cannot move an already collected batch to another project.
    const session = await getSession(env.SESSIONS, chatId, threadId);
    const sessionId = session?.activeSessionId || session?.lastSessionId;

    // Show the project picker immediately for new sessions with multiple projects,
    // instead of waiting for the user to press ▶️ and the debounce to expire.
    // This restores the pre-debounce UX where the picker appeared right after the first message.
    if (!sessionId && session && !session.pendingProjectChoice) {
      try {
        const decision = await getProjectDecision(env, { username: session.username, chatId });
        if (shouldAskProject({ isNewDialog: true, decision })) {
          await openProjectChoice(env, chatId, session, { decision, input: msg, threadId });
          return;
        }
      } catch { /* fail open — fall through to normal debounce path */ }
    }

    if (msg.reply_to_message || (sessionId && session?.projectSelectionSessionId === sessionId)) {
      if (sessionId) msg = { ...msg, intakeRoute: { sessionId,
        forceNew: !!(session.activeSessionId && session.activeSessionIsNew),
        projectId: session.projectId || null,
        projectChosen: session.projectSelectionSessionId === sessionId,
        projectPicked: session.projectSelectionSessionId === sessionId && !!session.projectPicked,
        newProject: !!session.pendingNewProject, contextFromSession: session.contextFromSession || null } };
    }
    // FORCE_RUN_RE: explicit launch words ("запускай/го") when buffer may have content.
    // AUTO_LAUNCH_RE: clear continuation signals ("продолжай/делай") — treated the same:
    // dispatch the buffer (or just this one message if buffer was empty) immediately.
    const flush = FORCE_RUN_RE.test(msg.text || '') || AUTO_LAUNCH_RE.test(msg.text || '');
    const stub = env.INTAKE.get(env.INTAKE.idFromName(conversationKey(chatId, threadId)));
    const res = await stub.fetch(env.AGENT_URL && env.SESSIONS && !flush ? 'https://intake/ingest' : 'https://intake/append', {
      method: 'POST',
      body: JSON.stringify({ text: msg.text, msg, flush }),
    });
    // «➕ Дополнить» armed → the buffer put this message into the supplement draft
    // instead (SS-06); the old handleMessage-side check was never reached from here.
    const diverted = await res?.json?.().catch(() => null);
    if (diverted?.supplement) await showSupplementConfirm(env, msg, chatId, threadId, diverted.supplement);
  } else {
    // Debounce kill-switch: the buffer is bypassed, so ask the supplement collector directly.
    if (env.INTAKE && hasIntakeContent(msg) && await captureSupplement(env, msg, chatId, threadId)) return;
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
