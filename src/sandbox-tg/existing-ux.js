import { Hono } from 'hono';
import { readTgSliceConfig } from './config.js';
import { createController } from './index.js';
import { IntakeBuffer } from '../intake-buffer.js';
export { IntakeBuffer };
import { TgDeliveryOwner } from './delivery-owner.js';
import { handleCallbackQuery } from '../handlers/callbacks.js';
import { getSession, setSession } from '../lib/kv.js';
import { applySessionNamespace } from '../lib/session-namespace.js';
import { conversationKey, threadIdOf } from '../conversation-context.js';
import { FORCE_RUN_RE, AUTO_LAUNCH_RE, hasIntakeContent } from '../intake-routing.js';
import { initTestMode, rememberCallback } from '../lib/test-mode.js';
import { answerCallbackQuery } from '../lib/telegram.js';
import { attachmentOf } from './batch.js';
import { profileForUpdate } from './profile.js';
import { prepareTelegramArtifact } from './media-intake.js';

const app = new Hono();

function executionEnv(env) {
  return applySessionNamespace({ ...env, EXECUTION_BACKEND: 'control-plane',
    BOT_TOKEN: env.TG_SANDBOX_BOT_TOKEN, BOT_USERNAME: env.TG_SANDBOX_BOT_USERNAME });
}

app.get('/health', context => context.json({ status: 'ok', mode: 'existing-ux-control-plane', acceptance: 'pending' }));

app.get('/cron', async context => {
  const config = readTgSliceConfig(context.env);
  if (!config.webhookSecret || context.req.header('x-telegram-bot-api-secret-token') !== config.webhookSecret) return context.json({ error: 'unauthorized' }, 401);
  const controller = createController(context.env, config);
  await controller.outbox.open();
  return context.json({ reconciled: true, ...await controller.reconcile() });
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
  if (!message?.chat || !config.allowedChats.includes(String(message.chat.id)) || !allowedUsers.includes(String(sender?.id))) return context.json({ error: 'owner refused' }, 403);
  if (!env.INTAKE || !env.SESSIONS || env.INTAKE_DEBOUNCE === 'off') return context.json({ error: 'collector not configured' }, 503);
  await createController(env, config).outbox.open();
  const threadId = threadIdOf(message);
  const session = await getSession(env.SESSIONS, message.chat.id, threadId);
  if (session?.controlPlaneProfile && session.controlPlaneProfile !== config.profileId) return context.json({ error: 'profile mismatch' }, 403);
  if (!session) await setSession(env.SESSIONS, message.chat.id, {
    username: 'integrator', telegramUserId: sender.id, controlPlaneProfile: config.profileId,
  }, threadId);
  initTestMode(env);
  if (update.callback_query) {
    rememberCallback(update.callback_query.id, message.chat.id);
    const data = update.callback_query.data ?? '';
    const stopBlocked = data.startsWith('intake_stop') && env.TG_SLICE_STOP_ENABLED !== 'true';
    const supported = ['intake_run', 'intake_parallel', 'intake_cancel', 'intake_stopsupp', 'intake_stopnew', 'input_draft', 'input_run'].includes(data)
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
  const attachment = attachmentOf(message);
  let collectorMessage = message;
  if (!['empty', 'text'].includes(attachment.type)) {
    if (env.MEDIA_PIPELINE !== 'ingress-buffer' || !env.INGRESS_BUFFER || !env.INGRESS_BUFFER_TOKEN) {
      return context.json({ error: 'media intake is not configured' }, 503);
    }
    let manifest;
    try {
      manifest = await prepareTelegramArtifact({ message, attachment, profile: profileForUpdate(config, update), config,
        buffer: env.INGRESS_BUFFER, bufferToken: env.INGRESS_BUFFER_TOKEN });
    } catch {
      return context.json({ error: 'media could not be stored; no task was started' }, 503);
    }
    const { photo, voice, audio, document, video, ...textMessage } = message;
    collectorMessage = { ...textMessage, ingressArtifactManifest: manifest,
      fileRef: { storage: 'ingress', id: manifest.ref, name: manifest.name, mime: manifest.mediaType } };
  }
  const stub = env.INTAKE.get(env.INTAKE.idFromName(conversationKey(message.chat.id, threadId)));
  const flush = FORCE_RUN_RE.test(collectorMessage.text ?? '') || AUTO_LAUNCH_RE.test(collectorMessage.text ?? '');
  const response = await stub.fetch('https://intake/append', {
    method: 'POST', body: JSON.stringify({ text: collectorMessage.text ?? collectorMessage.caption, msg: collectorMessage, flush, telegramUpdateId: update.update_id }),
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

export { TgDeliveryOwner };
