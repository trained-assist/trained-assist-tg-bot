import { Hono } from 'hono';
import { readTgSliceConfig } from './config.js';
import { createController } from './index.js';
import { IntakeBuffer } from '../intake-buffer.js';
import { TgDeliveryOwner } from './delivery-owner.js';
import { handleCallbackQuery } from '../handlers/callbacks.js';
import { getSession, setSession, deleteSession } from '../lib/kv.js';
import { applySessionNamespace } from '../lib/session-namespace.js';
import { conversationKey, threadIdOf } from '../conversation-context.js';
import { FORCE_RUN_RE, AUTO_LAUNCH_RE, hasIntakeContent } from '../intake-routing.js';
import { initTestMode, rememberCallback } from '../lib/test-mode.js';
import { answerCallbackQuery, sendMessage, sendMessageWithKeyboard } from '../lib/telegram.js';
import { ControlPlaneClient } from './control-plane-client.js';
import { cmdLogin } from '../handlers/commands.js';
import { handleUserMgmt, isUserMgmtCommand } from '../handlers/user-mgmt.js';
import acceptOnlyWorker, { SandboxAcceptOnlyStore } from './accept-only.js';

const app = new Hono();

app.all('/sandbox/accept-only/*', c => acceptOnlyWorker.fetch(c.req.raw, c.env));

function executionEnv(env) {
  return applySessionNamespace({ ...env, EXECUTION_BACKEND: 'control-plane',
    BOT_TOKEN: env.TG_SANDBOX_BOT_TOKEN, BOT_USERNAME: env.TG_SANDBOX_BOT_USERNAME,
    USERS: env.USERS ?? env.TG_SLICE, LOGIN_USERS: env.PRODUCTION_USERS,
    CONTROL_PLANE_PROFILE: env.CONTROL_PLANE_PROFILE });
}

app.get('/health', context => context.json({ status: 'ok', mode: 'existing-ux-control-plane', acceptance: 'pending' }));

app.get('/cron', async context => {
  const config = readTgSliceConfig(context.env);
  if (!config.webhookSecret || context.req.header('x-telegram-bot-api-secret-token') !== config.webhookSecret) return context.json({ error: 'unauthorized' }, 401);
  const controller = createController(context.env, config);
  await controller.outbox.open();
  return context.json({ reconciled: true, ...await controller.reconcile() });
});

app.get('/delivery-cutover', async context => {
  const config = readTgSliceConfig(context.env);
  if (!config.webhookSecret || context.req.header('x-telegram-bot-api-secret-token') !== config.webhookSecret) return context.json({ error: 'unauthorized' }, 401);
  try {
    return context.json(await createController(context.env, config).outbox.open());
  } catch {
    return context.json({ error: 'delivery owner refused' }, 503);
  }
});

app.get('/collector-state', async context => {
  const env = executionEnv(context.env);
  const config = readTgSliceConfig(env);
  if (!config.webhookSecret || context.req.header('x-telegram-bot-api-secret-token') !== config.webhookSecret) return context.json({ error: 'unauthorized' }, 401);
  const chatId = context.req.query('chatId');
  if (!config.allowedChats.includes(chatId)) return context.json({ error: 'owner refused' }, 403);
  const rawThread = context.req.query('threadId');
  const threadId = rawThread == null ? null : Number(rawThread);
  if (threadId != null && (!Number.isSafeInteger(threadId) || threadId <= 0)) return context.json({ error: 'invalid topic' }, 400);
  const stub = env.INTAKE.get(env.INTAKE.idFromName(conversationKey(chatId, threadId)));
  const response = await stub.fetch('https://intake/debug');
  return new Response(response.body, { status: response.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
});

// Owner-only recovery for the isolated probability sandbox. The dedicated
// token is independent of Telegram's webhook secret; no corresponding route is
// mounted by the production Worker.
app.post('/operator/stop-window', async context => {
  const env = executionEnv(context.env);
  const config = readTgSliceConfig(env);
  const token = String(env.TG_SANDBOX_OPERATOR_TOKEN ?? '').trim();
  if (!token || context.req.header('authorization') !== `Bearer ${token}`) return context.json({ error: 'unauthorized' }, 401);
  const source = await context.req.json().catch(() => null);
  const chatId = source?.chatId ?? (config.allowedChats.length === 1 ? Number(config.allowedChats[0]) : null);
  const profileId = source?.profileId ?? config.profileId;
  if (!source || !['inspect', 'release', 'abandon'].includes(source.mode) || !Number.isSafeInteger(chatId) ||
      (source.threadId != null && (!Number.isSafeInteger(source.threadId) || source.threadId <= 0)) ||
      profileId !== config.profileId ||
      (source.windowId != null && typeof source.windowId !== 'string') ||
      (source.mode !== 'inspect' && typeof source.windowId !== 'string') ||
      source.mode === 'abandon' && (source.confirmWindowId !== source.windowId ||
        source.auditReason !== 'sandbox_test_fixture_abandoned')) return context.json({ error: 'invalid selector' }, 400);
  if (!config.allowedChats.includes(String(chatId))) return context.json({ error: 'owner refused' }, 403);
  if (env.TG_SANDBOX_OPERATOR_RECOVERY !== 'enabled') return context.json({ error: 'recovery disabled' }, 404);
  const selector = { ...source, chatId, profileId, threadId: source.threadId ?? null };
  const stub = env.INTAKE.get(env.INTAKE.idFromName(conversationKey(chatId, selector.threadId)));
  const response = await stub.fetch('https://intake/operator/stop-window', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(selector),
  });
  return new Response(response.body, { status: response.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
});

app.post('/webhook', async context => {
  const env = executionEnv(context.env);
  const config = readTgSliceConfig(env);
  if (!config.webhookSecret || context.req.header('x-telegram-bot-api-secret-token') !== config.webhookSecret) return context.json({ error: 'unsigned update refused' }, 401);
  const update = await context.req.json().catch(() => null);
  if (!Number.isSafeInteger(update?.update_id)) return context.json({ error: 'bad update' }, 400);
  const message = update.message ?? update.callback_query?.message;
  const sender = update.callback_query?.from ?? message?.from;
  const allowedUsers = String(env.TG_SLICE_ALLOWED_USERS ?? '').split(',').map(value => value.trim()).filter(Boolean);
  if (!message?.chat || !sender?.id || (!config.openSandbox &&
      (!config.allowedChats.includes(String(message.chat.id)) || !allowedUsers.includes(String(sender.id))))) return context.json({ error: 'owner refused' }, 403);
  if (!env.SESSIONS) return context.json({ error: 'session store not configured' }, 503);
  const threadId = threadIdOf(message);
  const runtimeEnv = executionEnv(env);
  const command = String(message.text ?? '').trim().split(/\s+/)[0].split('@')[0].toLowerCase();
  let session = await getSession(runtimeEnv.SESSIONS, message.chat.id, threadId);
  if (session?.controlPlaneProfile && session.controlPlaneProfile !== config.profileId
      && !(session.telegramUserId === String(sender.id) && /^prof-[0-9a-f-]{36}$/.test(session.controlPlaneProfile))) {
    return context.json({ error: 'profile mismatch' }, 403);
  }

  const registrationInProgress = session?.registrationStep && session.registrationStep !== 'complete';
  if (config.openSandbox && session?.registrationStep === 'complete'
      && session.telegramUserId === String(sender.id) && /^prof-[0-9a-f-]{36}$/.test(session.controlPlaneProfile)) {
    // Registration identities must never fall through to the legacy login or
    // shared IntakeBuffer. Per-profile API execution is enabled only once the
    // CP has quota accounting and the Agent API workspace capability configured.
    return context.json({ error: 'profile execution is not enabled for this sandbox yet', code: 'PROFILE_EXECUTION_NOT_ENABLED' }, 503);
  }
  if (config.openSandbox && message.chat.type === 'private'
      && (command === '/start' || registrationInProgress)) {
    const clientConfig = { ...config, telegramUserId: String(sender.id) };
    const registrationClient = new ControlPlaneClient(clientConfig, {
      fetchImpl: env.CONTROL_PLANE_SERVICE ? env.CONTROL_PLANE_SERVICE.fetch.bind(env.CONTROL_PLANE_SERVICE) : undefined,
      logSink: line => console.log(line),
    });
    let registration;
    try { registration = (await registrationClient.registerTelegramUpdate(update)).value; }
    catch { return context.json({ error: 'registration service unavailable' }, 503); }
    const completed = registration?.step === 'complete';
    session = {
      username: completed ? `telegram-${sender.id}` : null,
      telegramUserId: String(sender.id),
      controlPlaneProfile: completed ? registration.profileId : null,
      registrationStep: completed ? 'complete' : registration?.step,
      registeredAt: completed ? (session?.registeredAt ?? Date.now()) : null,
    };
    await setSession(runtimeEnv.SESSIONS, message.chat.id, session, threadId);
    const text = String(registration?.message ?? 'Продолжите регистрацию.');
    if (env.TG_HTTP_TEST_MODE !== 'true') {
      if (registration?.step === 'profile_name') {
        await sendMessageWithKeyboard(env.TG_SANDBOX_BOT_TOKEN, message.chat.id, text,
          [[{ text: 'Пропустить', callback_data: 'registration_skip' }]], {}, runtimeEnv);
      } else await sendMessage(env.TG_SANDBOX_BOT_TOKEN, message.chat.id, text);
    }
    return context.json({ ok: true, registration, transcript: [text],
      buttons: registration?.step === 'profile_name' ? [{ text: 'Пропустить', callbackData: 'registration_skip' }] : [] });
  }

  if (!env.INTAKE || env.INTAKE_DEBOUNCE === 'off') return context.json({ error: 'collector not configured' }, 503);
  await createController(env, config).outbox.open();

  // Older sandbox builds silently assigned every sender the same synthetic
  // `integrator` profile. Keep those sessions inert and let the existing
  // username/password login replace them explicitly.
  if (session?.username === 'integrator') {
    if (command === '/login') {
      await deleteSession(runtimeEnv.SESSIONS, message.chat.id, threadId);
      session = null;
    } else session = null;
  }

  if (command === '/login') {
    await cmdLogin(message, runtimeEnv);
    const authenticated = await getSession(runtimeEnv.SESSIONS, message.chat.id, threadId);
    if (authenticated?.username && authenticated.username !== 'integrator') {
      await setSession(runtimeEnv.SESSIONS, message.chat.id,
        { ...authenticated, controlPlaneProfile: config.profileId }, threadId);
    }
    return context.json({ ok: true, authenticated: !!authenticated?.username && authenticated.username !== 'integrator' });
  }

  if (isUserMgmtCommand(message.text ?? '')) {
    if (!config.allowedChats.includes(String(message.chat.id)) || !allowedUsers.includes(String(sender.id))) {
      await sendMessage(env.TG_SANDBOX_BOT_TOKEN, message.chat.id,
        'Эта команда доступна оператору тестового бота.');
      return context.json({ ok: true, refused: true });
    }
    const userMessage = command === '/pass_reset'
      ? { ...message, text: message.text.replace(/^\/pass_reset(?=@|\s|$)/i, '/resetpass') }
      : message;
    await handleUserMgmt(userMessage, runtimeEnv);
    return context.json({ ok: true });
  }

  if (!session?.username || session.username === 'integrator') {
    if (update.callback_query) {
      await answerCallbackQuery(env.TG_SANDBOX_BOT_TOKEN, update.callback_query.id,
        'Сначала войди: /login username password');
      return context.json({ ok: true, authenticated: false });
    }
    if (String(message.text ?? '').trim().startsWith('/')) {
      await sendMessage(env.TG_SANDBOX_BOT_TOKEN, message.chat.id,
        'Команда не распознана. Логин профиля можно посмотреть командой /listusers в исходном админ-чате.\n' +
        'Здесь, в sandbox, выполни /pass_reset username — бот пришлёт тестовый пароль и команду входа.\n' +
        'Для входа: /login username password.');
      return context.json({ ok: true, authenticated: false, unknownCommand: true });
    }
    await sendMessage(env.TG_SANDBOX_BOT_TOKEN, message.chat.id,
      'Чтобы войти в этом чате, отправь <code>/login username password</code>.\n' +
      'Один и тот же профиль можно подключить отдельно в каждом чате.');
    return context.json({ ok: true, authenticated: false });
  }
  initTestMode(env);
  if (update.callback_query) {
    rememberCallback(update.callback_query.id, message.chat.id);
    const data = update.callback_query.data ?? '';
    const stopBlocked = data.startsWith('intake_stop') && env.TG_SLICE_STOP_ENABLED !== 'true';
    const supported = ['intake_run', 'intake_parallel', 'intake_cancel', 'intake_stopsupp', 'intake_stopnew', 'input_draft', 'input_run'].includes(data)
      || /^intake_dismiss_unknown\|[a-f0-9-]{36}$/.test(data)
      || /^ws\|(explore|answer|auto)\|\d+$/.test(data)
      || /^intake_discard\|\d+$/.test(data)
      || ['intake_stopyes|', 'intake_stopno|', 'input_run|'].some(prefix => data.startsWith(prefix));
    if (!supported || stopBlocked) {
      await answerCallbackQuery(env.BOT_TOKEN, update.callback_query.id, 'Эта функция ещё не подключена к новому Control Plane.');
      return context.json({ ok: true, unsupported: true });
    }
    await handleCallbackQuery(update.callback_query, env);
    return context.json({ ok: true });
  }
  if (!hasIntakeContent(message)) return context.json({ ok: true, unsupported: true });
  const stub = env.INTAKE.get(env.INTAKE.idFromName(conversationKey(message.chat.id, threadId)));
  const flush = FORCE_RUN_RE.test(message.text ?? '') || AUTO_LAUNCH_RE.test(message.text ?? '');
  const response = await stub.fetch('https://intake/append', {
    method: 'POST', body: JSON.stringify({ text: message.text ?? message.caption, msg: message, flush, telegramUpdateId: update.update_id }),
  });
  if (!response.ok) return context.json({ error: 'collector admission failed' }, 503);
  return context.json({ ok: true, ...(await response.json()) });
});

app.get('/deliveries/:taskId', async context => {
  const config = readTgSliceConfig(context.env);
  if (context.req.header('x-telegram-bot-api-secret-token') !== config.webhookSecret) return context.json({ error: 'unauthorized' }, 401);
  const taskId = context.req.param('taskId');
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(taskId)) return context.json({ error: 'invalid task id' }, 400);
  return context.json(await createController(context.env, config).outbox.read(taskId));
});

export default {
  fetch: app.fetch,
  async scheduled(event, env) {
    const controller = createController(env);
    await controller.outbox.open();
    await controller.reconcile();
  },
};

export class IntakeBufferReset extends IntakeBuffer {}

export { IntakeBuffer, TgDeliveryOwner, SandboxAcceptOnlyStore };
