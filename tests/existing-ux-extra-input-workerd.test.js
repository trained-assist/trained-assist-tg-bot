import { expect, it } from 'vitest';
import { buildSync } from 'esbuild';
import { Miniflare } from 'miniflare';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { makeEnv } from './helpers/p11-helpers.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const answer = 'Offline aggregate fixture: preserved first and additional input.';

function bundle() {
  return buildSync({ stdin: { resolveDir: process.cwd(), contents: `
    import worker, { IntakeBuffer as RealIntakeBuffer, TgDeliveryOwner } from './src/sandbox-tg/existing-ux.js';
    export default worker;
    export { TgDeliveryOwner };
    export class IntakeBuffer extends RealIntakeBuffer {
      async fetch(request) {
        if (new URL(request.url).pathname === '/offline-draft-revision') {
          if (request.headers.get('x-offline-probe') !== 'fixture') return new Response(null, {status:401});
          return Response.json({ draftRevision: await this.state.storage.get('draftRevision') });
        }
        if (new URL(request.url).pathname === '/offline-alarm') {
          if (request.headers.get('x-offline-probe') !== 'fixture') return new Response(null, {status:401});
          await this.alarm();
          return Response.json({sqliteWitness:[...this.state.storage.sql.exec('SELECT 1 AS witness')][0].witness});
        }
        return super.fetch(request);
      }
    }
  ` }, bundle: true, write: false, format: 'esm', platform: 'browser', external: ['node:*'],
  nodePaths: [resolve('node_modules')] }).outputFiles[0].text;
}

it.each(['before-collector', 'after-collector'])('retains two-message aggregate across cold SQLite restart: %s', async boundary => {
  const persistRoot = await mkdtemp(join(tmpdir(), 'tg-extra-input-offline-'));
  const env = makeEnv({ CONTROL_PLANE_URL: 'https://cp.test', CONTROL_PLANE_PROFILE: 'extra-input-profile',
    CONTROL_PLANE_SESSION_ID: 'extra-input-session', TG_SLICE_ALLOWED_CHATS: '42', TG_SLICE_ALLOWED_USERS: '43',
    TG_SANDBOX_BOT_TOKEN: 'offline-extra-input-token', TELEGRAM_WEBHOOK_SECRET: 'offline-extra-input-webhook',
    TG_SLICE_STOP_ENABLED: 'false', TG_SLICE_DELIVERY_PAUSED: 'false', EXECUTION_BACKEND: 'control-plane',
    AGENT_URL: 'https://legacy.test', TELEGRAM_API_BASE: 'https://api.telegram.org',
    TG_SLICE_DELIVERY_CUTOVER_MANIFEST: JSON.stringify({ version: 'tg-delivery-cutover-v1',
      botUsername: 'probability_cat_bot', profileId: 'extra-input-profile', cutoverId: 'offline-extra-input',
      cutoverAt: 1791190000000, oldTaskIds: [], deliveries: [] }) });
  const sends = [];
  const edits = [];
  const intakes = [];
  const routes = [];
  const unexpected = [];
  const dispatches = new Set();
  let accepted;
  let completed = false;
  const outboundService = async request => {
    const url = new URL(request.url);
    const body = request.method === 'POST' ? await request.json() : null;
    if (url.hostname === 'api.telegram.org') {
      if (url.pathname.endsWith('/sendMessage')) {
        sends.push(body);
        return Response.json({ ok: true, result: { message_id: 700 + sends.length } });
      }
      if (url.pathname.endsWith('/editMessageText')) {
        edits.push(body);
        return Response.json({ ok: true, result: { message_id: body.message_id } });
      }
      if (url.pathname.endsWith('/answerCallbackQuery')) return Response.json({ ok: true });
    }
    if (url.hostname === 'cp.test' && url.pathname === '/intake') {
      intakes.push(body);
      expect(accepted).toBeUndefined();
      accepted = { ...body, taskId: `ut-${digest(`${body.profileId}\0${body.requestId}`).slice(0, 20)}` };
      return Response.json({ receiptId: 'offline-extra-input-receipt', requestId: body.requestId,
        userTaskId: accepted.taskId, profileId: body.profileId, acceptedAt: 1791190800000,
        durable: true, duplicate: false }, { status: 201 });
    }
    if (url.hostname === 'cp.test' && url.pathname === '/route') {
      routes.push(body);
      expect(body).toEqual({ taskId: accepted.taskId, continue: true });
      dispatches.add(body.taskId);
      return Response.json({ decisionId: 'offline-extra-input-decision', route: 'agent', mode: 'agent',
        needsExecutor: true, continuation: { owner: 'output', requested: true, issued: true,
          runId: 'run-offline-extra-input' } });
    }
    if (url.hostname === 'cp.test' && url.pathname === '/status') {
      expect(body.taskId).toBe(accepted.taskId);
      return Response.json({ taskStore: { id: accepted.taskId, profile_id: env.CONTROL_PLANE_PROFILE,
        generation: 1, status: completed ? 'done' : 'active', result: completed ? { answer } : null },
      runs: [{ id: 'run-offline-extra-input', generation: 1, status: completed ? 'done' : 'running' }] });
    }
    unexpected.push({ host: url.hostname, path: url.pathname });
    return Response.json({ error: 'offline transport not configured' }, { status: 500 });
  };
  const options = { name: 'extra-input-offline', script: bundle(), modules: true, compatibilityDate: '2024-01-01',
    compatibilityFlags: ['nodejs_compat'], outboundService, kvNamespaces: ['TG_SLICE', 'SESSIONS'],
    kvPersist: join(persistRoot, 'kv'), durableObjectsPersist: join(persistRoot, 'do'),
    durableObjects: { INTAKE: { className: 'IntakeBuffer', useSQLite: true },
      TG_DELIVERY_OWNER: { className: 'TgDeliveryOwner', useSQLite: true } },
    bindings: Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === 'string')) };
  let runtime;
  const headers = { 'x-telegram-bot-api-secret-token': env.TELEGRAM_WEBHOOK_SECRET };
  const message = (messageId, text) => ({ update_id: messageId,
    message: { message_id: messageId, date: 1791190800, chat: { id: 42, type: 'private' },
      from: { id: 43, is_bot: false }, text } });
  const sendUpdate = async update => {
    const response = await runtime.dispatchFetch('https://worker.test/webhook', { method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(update) });
    expect(response.status).toBe(200);
    return response.json();
  };
  const state = async () => {
    const response = await runtime.dispatchFetch('https://worker.test/collector-state?chatId=42', { headers });
    expect(response.status).toBe(200);
    return response.json();
  };
  const draftRevision = async () => {
    const namespace = await runtime.getDurableObjectNamespace('INTAKE');
    const response = await namespace.get(namespace.idFromName('42')).fetch('https://intake/offline-draft-revision', {
      headers: { 'x-offline-probe': 'fixture' } });
    expect(response.status).toBe(200);
    return (await response.json()).draftRevision;
  };
  const alarm = async () => {
    const namespace = await runtime.getDurableObjectNamespace('INTAKE');
    const response = await namespace.get(namespace.idFromName('42')).fetch('https://intake/offline-alarm', {
      headers: { 'x-offline-probe': 'fixture' } });
    expect(await response.json()).toEqual({ sqliteWitness: 1 });
  };
  const receiptAlarm = async () => {
    const due = (await state()).receiptDue;
    expect(due).toBeTypeOf('number');
    await new Promise(resolveWait => setTimeout(resolveWait, Math.max(0, due - Date.now()) + 50));
    await alarm();
  };
  const delivery = async () => {
    const response = await runtime.dispatchFetch(`https://worker.test/deliveries/${accepted.taskId}`, { headers });
    expect(response.status).toBe(200);
    return response.json();
  };
  try {
    runtime = new Miniflare(options);
    const first = message(200, '[Offline fixture] Preserve this first instruction and value 150.');
    const extra = message(201, 'Additional input: also preserve value 275. Reply using both values; no files.');
    await sendUpdate(first);
    expect(intakes).toHaveLength(0);
    expect(routes).toHaveLength(0);
    if (boundary === 'after-collector') await receiptAlarm();
    const before = await state();
    expect(before.buf.map(item => item.messageId)).toEqual([200]);
    expect(sends).toHaveLength(boundary === 'after-collector' ? 1 : 0);
    await runtime.dispose();
    runtime = new Miniflare(options);
    expect((await state()).buf).toEqual(before.buf);
    expect((await state()).collectorMsgId).toBe(before.collectorMsgId);
    expect(await sendUpdate(first)).toMatchObject({ duplicate: true });
    await sendUpdate(extra);
    await sendUpdate(extra);
    expect((await state()).buf.map(item => item.messageId)).toEqual([200, 201]);
    expect(intakes).toHaveLength(0);
    expect(routes).toHaveLength(0);
    await receiptAlarm();
    const collected = await state();
    expect(collected.collectorMsgId).toBe(701);
    expect(collected.collectorDelivery).toMatchObject({ state: 'sent', messageId: 701 });
    expect(sends).toHaveLength(1);
    const buttons = sends[0].reply_markup.inline_keyboard.flat().map(button => button.callback_data);
    expect(buttons.filter(data => data.startsWith('ws|'))).toHaveLength(3);
    expect(buttons.some(data => data.startsWith('intake_stop'))).toBe(false);
    if (boundary === 'after-collector') expect(edits.some(edit => edit.message_id === 701)).toBe(true);
    const launch = { update_id: 202, callback_query: { id: 'offline-extra-input-launch',
      from: { id: 43, is_bot: false }, data: `ws|answer|${await draftRevision()}`,
      message: { message_id: 701, chat: { id: 42, type: 'private' } } } };
    await sendUpdate(launch);
    await sendUpdate(launch);
    expect(intakes).toHaveLength(1);
    expect(intakes[0].inputItems).toEqual([{ text: first.message.text, artifactRefs: [] },
      { text: extra.message.text, artifactRefs: [] }]);
    const batchRequestId = `tg-${digest('42:200,201')}`;
    expect(intakes[0].requestId).toBe(`tgcp-${digest(`probability_cat_bot:extra-input-profile:42::${batchRequestId}`)}`);
    expect(routes).toHaveLength(1);
    expect(dispatches.size).toBe(1);
    completed = true;
    await alarm();
    expect(routes).toEqual([{ taskId: accepted.taskId, continue: true }]);
    expect(dispatches.size).toBe(1);
    const reconciledRoutes = structuredClone(routes);
    expect(sends.filter(item => item.text === answer)).toHaveLength(1);
    const terminal = await delivery();
    expect(terminal.receipt).toBeNull();
    expect(terminal.terminal).toMatchObject({ deliveryId: `terminal:${accepted.taskId}:g1`,
      userTaskId: accepted.taskId, generation: 1, status: 'sent', attempts: 1,
      providerMessageId: 702, chatId: 42, threadId: null });
    await runtime.dispose();
    runtime = new Miniflare(options);
    await sendUpdate(launch);
    await sendUpdate(first);
    await sendUpdate(extra);
    await alarm();
    expect(await delivery()).toEqual(terminal);
    expect((await state()).buf).toEqual([]);
    expect(intakes).toHaveLength(1);
    expect(routes).toEqual(reconciledRoutes);
    expect(dispatches.size).toBe(1);
    expect(sends).toHaveLength(2);
    expect(sends.filter(item => item.text === answer)).toHaveLength(1);
    expect(unexpected).toEqual([]);
  } finally {
    if (runtime) await runtime.dispose();
    await rm(persistRoot, { recursive: true, force: true });
  }
}, 30000);
