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
import { answerCallbackQuery, sendMessage } from '../lib/telegram.js';
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
  if (!env.INTAKE || !env.SESSIONS || env.INTAKE_DEBOUNCE === 'off') return context.json({ error: 'collector not configured' }, 503);
  await createController(env, config).outbox.open();
  const threadId = threadIdOf(message);
  const runtimeEnv = executionEnv(env);
  const command = String(message.text ?? '').trim().split(/\s+/)[0].split('@')[0].toLowerCase();
  let session = await getSession(runtimeEnv.SESSIONS, message.chat.id, threadId);
  if (session?.controlPlaneProfile && session.controlPlaneProfile !== config.profileId) return context.json({ error: 'profile mismatch' }, 403);

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
