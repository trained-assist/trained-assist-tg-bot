import { Hono } from 'hono';
import { readTgSliceConfig, TgSliceConfigError } from './config.js';
import { ControlPlaneClient } from './control-plane-client.js';
import { TgDeliveryOwnerClient } from './delivery-owner.js';
import { KvConversationStore } from './conversation.js';
import { KvBatchStore } from './batch.js';
import { TgSliceController, MODE } from './worker.js';
import { profileForUpdate } from './profile.js';

const app = new Hono();

app.use('*', async (c, next) => {
  if (c.req.path === '/health') return next();
  const secret = String(c.env.TELEGRAM_WEBHOOK_SECRET ?? '').trim();
  const token = c.req.header('x-telegram-bot-api-secret-token');
  if (!secret || token !== secret) return c.json({ error: 'unsigned update refused' }, 401);
  try {
    const config = readTgSliceConfig(c.env);
    c.env = { ...c.env, _sliceConfig: config, _sliceCtrl: createController(c.env, config) };
    await c.env._sliceCtrl.outbox.open();
  } catch (error) {
    if (error instanceof TgSliceConfigError) return c.json({ error: 'sandbox not configured', binding: error.variable }, 503);
    throw error;
  }
  return next();
});

app.get('/health', c => {
  const required = ['TG_SANDBOX_BOT_TOKEN', 'CONTROL_PLANE_URL', 'CONTROL_PLANE_PRINCIPAL', 'CONTROL_PLANE_PROFILE', 'TELEGRAM_WEBHOOK_SECRET', 'TG_SLICE_ALLOWED_CHATS'];
  const missing = required.filter(name => !String(c.env[name] ?? '').trim());
  if (!c.env.TG_DELIVERY_OWNER?.idFromName || !c.env.TG_DELIVERY_OWNER?.get) missing.push('TG_DELIVERY_OWNER');
  if (!String(c.env.TG_SLICE_DELIVERY_CUTOVER_MANIFEST ?? '').trim()) missing.push('TG_SLICE_DELIVERY_CUTOVER_MANIFEST');
  return c.json({ status: 'ok', readiness: missing.length ? 'not_configured' : 'configured', missingBindings: missing, bot: c.env.TG_SANDBOX_BOT_USERNAME, mode: c.env.TG_SLICE_MODE ?? MODE.direct });
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
  try { return c.json(await c.env._sliceCtrl.outbox.read(taskId)); }
  catch (error) { return c.json({ error: 'delivery owner refused' }, error.status === 403 ? 403 : 503); }
});

app.get('/cron', async c => {
  const result = await c.env._sliceCtrl.reconcile();
  return c.json({ reconciled: true, ...result });
});

app.get('/delivery-cutover', async c => c.json(await c.env._sliceCtrl.outbox.open()));

const webhook = app;

function createController(env, config = readTgSliceConfig(env)) {
  const client = new ControlPlaneClient(config, {
    fetchImpl: env.CONTROL_PLANE_SERVICE ? env.CONTROL_PLANE_SERVICE.fetch.bind(env.CONTROL_PLANE_SERVICE) : undefined,
    logSink: line => console.log(line),
  });
  const outbox = new TgDeliveryOwnerClient(env, config);
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
    const controller = createController(env);
    await controller.outbox.open();
    await controller.reconcile();
  },
};

export { TgDeliveryOwner } from './delivery-owner.js';
