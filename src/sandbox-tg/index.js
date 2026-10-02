import { Hono } from 'hono';
import { readTgSliceConfig, authScheme } from './config.js';
import { ControlPlaneClient } from './control-plane-client.js';
import { TelegramApi } from './telegram.js';
import { TgDeliveryOutbox } from './delivery.js';
import { KvConversationStore } from './conversation.js';
import { KvBatchStore } from './batch.js';
import { TgSliceController, MODE } from './worker.js';
import { profileForUpdate } from './profile.js';

const app = new Hono();

app.use('*', async (c, next) => {
  const secret = c.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret) {
    const token = c.req.header('x-telegram-bot-api-secret-token');
    if (token !== secret) return c.json({ error: 'unsigned update refused' }, 401);
  }
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
  return c.json({ ok: true, duplicate: result.duplicate ?? false, userTaskId: first?.userTaskId ?? null, text });
});

app.get('/cron', async c => {
  const result = await c.env._sliceCtrl.reconcile();
  return c.json({ reconciled: true, ...result });
});

const webhook = app;

export default {
  async fetch(request, env) {
    const config = readTgSliceConfig(env);
    const client = new ControlPlaneClient(config, { logSink: line => console.log(line) });
    const api = new TelegramApi(config);
    const outbox = new TgDeliveryOutbox(
      env.TG_SLICE,
      api,
      { deliveryMaxAttempts: config.deliveryMaxAttempts, retryBaseMs: config.deliveryRetryBaseMs, logSink: line => console.log(line) },
    );
    const store = new KvConversationStore(env.TG_SLICE);
    const controller = new TgSliceController(client, store, {
      batchStore: new KvBatchStore(env.TG_SLICE),
      outbox,
      profile: config,
      mode: env.TG_SLICE_MODE ?? MODE.direct,
      maxTurns: config.maxTurns,
      logSink: line => console.log(line),
    });
    const enriched = { ...env, _sliceConfig: config, _sliceCtrl: controller };
    return webhook.fetch(request, enriched);
  },
  async scheduled(ctrl, env) {
    await env._sliceCtrl.reconcile();
  },
};