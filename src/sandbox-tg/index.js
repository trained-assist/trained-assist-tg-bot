import { Hono } from 'hono';
import { readTgSliceConfig } from './config.js';
import { ControlPlaneClient } from './control-plane-client.js';
import { TelegramApi } from './telegram.js';
import { TgDeliveryOutbox } from './delivery.js';
import { KvConversationStore } from './conversation.js';
import { KvBatchStore } from './batch.js';
import { TgSliceController, MODE } from './worker.js';
import { profileForUpdate } from './profile.js';
import { kvEntries } from './kv.js';

const app = new Hono();

app.use('*', async (c, next) => {
  if (c.req.path === '/health') return next();
  const secret = String(c.env.TELEGRAM_WEBHOOK_SECRET ?? '').trim();
  const token = c.req.header('x-telegram-bot-api-secret-token');
  if (!secret || token !== secret) return c.json({ error: 'unsigned update refused' }, 401);
  const config = readTgSliceConfig(c.env);
  c.env = { ...c.env, _sliceConfig: config, _sliceCtrl: createController(c.env, config) };
  return next();
});

app.get('/health', c => {
  return c.json({ status: 'ok', bot: c.env.TG_SANDBOX_BOT_USERNAME, mode: c.env.TG_SLICE_MODE ?? MODE.direct });
});

app.post('/webhook', async c => {
  let update;
  try {
    update = await c.req.json();
  } catch {
    return c.json({ error: 'bad json' }, 400);
  }
  if (!update || typeof update.update_id !== 'number') return c.json({ error: 'bad update' }, 400);
  const config = c.env._sliceConfig;
  const profile = profileForUpdate(config, update);
  if (!profile) return c.json({ error: 'chat not allowed', duplicate: false }, 403);
  const result = await c.env._sliceCtrl.handleUpdate(update);
  const first = result.effects?.[0];
  const text = first?.type === 'refused' ? first.text : 'ok';
  return c.json({ ok: true, duplicate: result.duplicate ?? false, userTaskId: result.userTaskId ?? first?.userTaskId ?? null, text });
});

app.get('/deliveries/:taskId', async c => {
  const taskId = c.req.param('taskId');
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(taskId)) return c.json({ error: 'invalid task id' }, 400);
  const outbox = new TgDeliveryOutbox(c.env.TG_SLICE, null);
  let terminal = await outbox.load(`terminal:${taskId}`);
  for await (const entry of kvEntries(c.env.TG_SLICE, `delivery:terminal:${taskId}:g`)) {
    const record = JSON.parse(entry.value);
    if (record.userTaskId !== taskId) continue;
    if (!terminal || Number(record.generation ?? 0) >= Number(terminal.generation ?? 0)) terminal = record;
  }
  const records = [await outbox.load(taskId), terminal];
  const config = c.env._sliceConfig;
  if (records.some(record => record && !config.allowedChats.includes(String(record.destination?.chatId)))) {
    return c.json({ error: 'chat not allowed' }, 403);
  }
  const summary = record => record ? {
    deliveryId: record.deliveryId,
    userTaskId: record.userTaskId,
    status: record.status,
    attempts: record.attempts,
    providerMessageId: record.telegramMessageId ?? null,
    generation: record.generation ?? null,
    chatId: record.destination.chatId,
    threadId: record.destination.threadId ?? null,
  } : null;
  return c.json({ receipt: summary(records[0]), terminal: summary(records[1]) });
});

app.get('/cron', async c => {
  const result = await c.env._sliceCtrl.reconcile();
  return c.json({ reconciled: true, ...result });
});

const webhook = app;

function createController(env, config = readTgSliceConfig(env)) {
  const client = new ControlPlaneClient(config, { logSink: line => console.log(line) });
  const api = new TelegramApi(config);
  const outbox = new TgDeliveryOutbox(
    env.TG_SLICE,
    api,
    { deliveryMaxAttempts: config.deliveryMaxAttempts, retryBaseMs: config.deliveryRetryBaseMs, logSink: line => console.log(line) },
  );
  const store = new KvConversationStore(env.TG_SLICE);
  return new TgSliceController(client, store, {
    batchStore: new KvBatchStore(env.TG_SLICE),
    outbox,
    profile: config,
    mode: env.TG_SLICE_MODE ?? MODE.direct,
    maxTurns: config.maxTurns,
    logSink: line => console.log(line),
  });
}

export default {
  async fetch(request, env) {
    return webhook.fetch(request, env);
  },
  async scheduled(ctrl, env) {
    await createController(env).reconcile();
  },
};
