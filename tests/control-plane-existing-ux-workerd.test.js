import { expect, it } from 'vitest';
import { buildSync } from 'esbuild';
import { Miniflare } from 'miniflare';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { makeEnv } from './helpers/p11-helpers.js';

function existingUxWorkerdBundle() {
  const sourceRoot = process.env.EXISTING_UX_SCENARIO_SOURCE_ROOT ?? process.cwd();
  return buildSync({
    stdin: { resolveDir: sourceRoot, contents: `
      import worker, { IntakeBuffer as RealIntakeBuffer, TgDeliveryOwner } from './src/sandbox-tg/existing-ux.js';
      export default {
        async fetch(request, env, context) {
          if (new URL(request.url).pathname === '/scenario-reconcile') {
            if (request.headers.get('x-scenario-probe') !== 'offline-probe') return new Response(null, { status: 401 });
            await worker.scheduled({}, env);
            return Response.json({ reconciled: true });
          }
          return worker.fetch(request, env, context);
        },
        scheduled: worker.scheduled,
      };
      export { TgDeliveryOwner };
      export class IntakeBuffer extends RealIntakeBuffer {
        async fetch(request) {
          const path = new URL(request.url).pathname;
          if (path === '/scenario-cleanup-prepare') {
            if (request.headers.get('x-scenario-probe') !== 'offline-probe') return new Response(null, { status: 401 });
            const { intent, alarmAt } = await request.json();
            await this.state.storage.put('cpCollectorCleanupRequests', [intent.requestId]);
            await this.state.storage.put('cp-collector-cleanup:' + intent.requestId, intent);
            await this.state.storage.put('input-message:' + intent.messageId, intent.requestId);
            await this.state.storage.setAlarm(alarmAt);
            return Response.json({ alarmAt: await this.state.storage.getAlarm() });
          }
          if (path === '/scenario-state' || path === '/scenario-alarm') {
            if (request.headers.get('x-scenario-probe') !== 'offline-probe') return new Response(null, { status: 401 });
            if (path === '/scenario-alarm') await this.alarm();
            const rows = [...this.state.storage.sql.exec('SELECT 1 AS sqliteWitness')];
            return Response.json({ sqliteWitness: rows[0].sqliteWitness, alarmAt: await this.state.storage.getAlarm(),
              entries: [...await this.state.storage.list()] });
          }
          return super.fetch(request);
        }
      }
    ` },
    bundle: true, write: false, format: 'esm', platform: 'browser', external: ['node:*'],
    nodePaths: [resolve('node_modules')],
  }).outputFiles[0].text;
}

async function workerdWaitFor(predicate) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Local workerd scenario observation timed out');
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
}

it('cold SQLite cleanup preserves a real earlier Durable Object alarm through recovery and alarm processing', async () => {
  const persistRoot = await mkdtemp(join(tmpdir(), 'tg-cleanup-alarm-workerd-'));
  const env = makeEnv({ EXECUTION_BACKEND: 'control-plane', CONTROL_PLANE_URL: 'https://cp.test' });
  const edits = [];
  const options = { modules: true, script: existingUxWorkerdBundle(), compatibilityDate: '2024-01-01',
    compatibilityFlags: ['nodejs_compat'], kvNamespaces: ['TG_SLICE', 'SESSIONS'],
    kvPersist: join(persistRoot, 'kv'), durableObjectsPersist: join(persistRoot, 'do'),
    bindings: Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === 'string')),
    durableObjects: { INTAKE: { className: 'IntakeBuffer', useSQLite: true },
      TG_DELIVERY_OWNER: { className: 'TgDeliveryOwner', useSQLite: true } },
    outboundService: async request => {
      const url = new URL(request.url);
      expect(url.hostname).toBe('api.telegram.org');
      expect(url.pathname.endsWith('/editMessageText')).toBe(true);
      edits.push(await request.json());
      return Response.json({ ok: false, error_code: 503, description: 'Offline edit acknowledgement unavailable' }, { status: 503 });
    },
  };
  let runtime = new Miniflare(options);
  const probe = async (path, body) => {
    const namespace = await runtime.getDurableObjectNamespace('INTAKE');
    const response = await namespace.get(namespace.idFromName('42')).fetch('https://intake/' + path, {
      method: body ? 'POST' : 'GET', headers: { 'x-scenario-probe': 'offline-probe' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    expect(response.status).toBe(200);
    return response.json();
  };
  try {
    const alarmAt = Date.now() + 30000;
    const intent = { requestId: 'cleanup-earlier-alarm', profileId: env.CONTROL_PLANE_PROFILE,
      state: 'pending', messageId: 99, chatId: 42, text: 'Terminal collector status' };
    expect(await probe('scenario-cleanup-prepare', { intent, alarmAt })).toEqual({ alarmAt });
    await runtime.dispose();
    runtime = new Miniflare(options);
    expect((await probe('scenario-state')).alarmAt).toBe(alarmAt);
    const after = await probe('scenario-alarm');
    expect(after.sqliteWitness).toBe(1);
    expect(edits).toHaveLength(1);
    expect(after.alarmAt).toBe(alarmAt);
    expect(new Map(after.entries).get('cp-collector-cleanup:' + intent.requestId)).toEqual(intent);
    expect(new Map(after.entries).get('cpCollectorCleanupRequests')).toEqual([intent.requestId]);
  } finally {
    await runtime.dispose();
    await rm(persistRoot, { recursive: true, force: true });
  }
});

it.each(['vertical', 'route', 'intake', 'stop', 'stop-disabled', 'collector-cleanup'])('real signed workerd SQLite existing UX scenario: %s', async boundary => {
  const script = existingUxWorkerdBundle();
  const persistRoot = await mkdtemp(join(tmpdir(), 'tg-existing-ux-workerd-'));
  const env = makeEnv({ CONTROL_PLANE_URL: 'https://cp.test',
    CONTROL_PLANE_PROFILE: 'workerd-profile', TG_SLICE_ALLOWED_CHATS: '42', TG_SLICE_ALLOWED_USERS: '43',
    TG_SANDBOX_BOT_TOKEN: 'offline-workerd-token', TELEGRAM_API_BASE: 'https://api.telegram.org',
    TELEGRAM_WEBHOOK_SECRET: 'offline-workerd-webhook', TG_SLICE_DELIVERY_PAUSED: 'false',
    TG_SLICE_DELIVERY_CUTOVER_MANIFEST: JSON.stringify({ version: 'tg-delivery-cutover-v1',
      botUsername: 'probability_cat_bot', profileId: 'workerd-profile', cutoverId: 'offline-empty-inventory',
      cutoverAt: 1791190000000, oldTaskIds: [], deliveries: [] }),
    EXECUTION_BACKEND: 'control-plane', AGENT_URL: 'https://legacy.test',
    AGENT_SECRET: 'offline-legacy-secret', CONTROL_PLANE_SESSION_ID: 'workerd-source-session' });
  const providerMessages = [];
  const providerEdits = [];
  const cpIntakes = [];
  const cpRoutes = [];
  const cpStopRequests = [];
  const legacyRequests = [];
  const admittedTasks = new Map();
  const dispatchedTasks = new Set();
  const completedTasks = new Set();
  let admitted = null;
  let dispatchCount = 0;
  let lostAck = true;
  const unexpectedRequests = [];
  const reply = (data, status = 200) => Response.json(data, { status });
  const outboundService = async request => {
    const url = new URL(request.url);
    const body = request.method === 'POST' ? await request.json() : null;
    if (url.hostname === 'api.telegram.org') {
      if (url.pathname === `/bot${env.TG_SANDBOX_BOT_TOKEN}/sendMessage`) {
        providerMessages.push(body);
        return reply({ ok: true, result: { message_id: 500 + providerMessages.length } });
      }
      if (url.pathname === `/bot${env.TG_SANDBOX_BOT_TOKEN}/editMessageText`) {
        providerEdits.push(body);
        return reply({ ok: true, result: { message_id: body.message_id } });
      }
      if (url.pathname === `/bot${env.TG_SANDBOX_BOT_TOKEN}/answerCallbackQuery`) return reply({ ok: true });
    }
    if (url.hostname === 'cp.test' && url.pathname === '/intake') {
      const envelope = body;
      cpIntakes.push(envelope);
      const identity = `${envelope.profileId}:${envelope.requestId}`;
      const existing = admittedTasks.get(identity);
      if (existing && JSON.stringify(existing.envelope) !== JSON.stringify(envelope)) return reply({ error: 'changed envelope' }, 409);
      const duplicate = !!existing;
      if (!existing) admittedTasks.set(identity, { envelope,
        taskId: admittedTasks.size === 0 ? 'ut-workerd-scenario' : 'ut-workerd-followup' });
      const task = admittedTasks.get(identity);
      admitted ??= envelope;
      if (boundary === 'intake' && lostAck) {
        lostAck = false;
        return reply({ error: 'injected lost intake acknowledgement after acceptance' }, 503);
      }
      return reply({ receiptId: `receipt-${task.taskId}`, requestId: envelope.requestId,
        userTaskId: task.taskId, profileId: envelope.profileId,
        acceptedAt: 1791190800000, durable: true, duplicate }, duplicate ? 200 : 201);
    }
    if (url.hostname === 'cp.test' && url.pathname === '/route') {
      cpRoutes.push(body);
      const task = [...admittedTasks.values()].find(value => value.taskId === body.taskId);
      if (!task) return reply({ error: 'unknown task' }, 404);
      if (!dispatchedTasks.has(task.taskId)) dispatchCount += 1;
      dispatchedTasks.add(task.taskId);
      if (boundary === 'route' && lostAck) {
        lostAck = false;
        return reply({ error: 'injected lost routing acknowledgement after dispatch' }, 503);
      }
      return reply({ decisionId: 'workerd-decision', route: 'agent', mode: 'agent', needsExecutor: true,
        continuation: { owner: 'output', requested: true, issued: true, runId: `run-${task.taskId}` } });
    }
    if (url.hostname === 'cp.test' && url.pathname === '/cp-stop-targets') {
      cpStopRequests.push(body);
      const tasks = body.admissionRequestIds.map(requestId => {
        const entry = [...admittedTasks.values()].find(value => value.envelope.requestId === requestId);
        return { requestId, userTaskId: entry?.taskId, profileId: body.profileId, receiptId: `receipt-${entry?.taskId}` };
      });
      return reply({ snapshotId: `stop-${cpStopRequests.length}`, profileId: body.profileId,
        conversationId: body.conversationId, tasks, unresolved: false, stopConfirmed: true, reason: null });
    }
    if (url.hostname === 'cp.test' && url.pathname === '/status') return reply({
      taskStore: { id: body.taskId, profile_id: env.CONTROL_PLANE_PROFILE,
        status: completedTasks.has(body.taskId) ? 'done' : 'active', generation: 1,
        result: completedTasks.has(body.taskId) ? { answer: 'Offline engine fixture completed.' } : null },
      runs: dispatchedTasks.has(body.taskId) ? [{ id: `run-${body.taskId}`,
        status: completedTasks.has(body.taskId) ? 'done' : 'running', generation: 1 }] : [],
    });
    if (url.hostname === 'legacy.test') {
      legacyRequests.push(url.pathname);
      return reply({ error: 'legacy transport forbidden' }, 500);
    }
    unexpectedRequests.push({ host: url.hostname, path: url.pathname });
    return reply({ error: 'unconfigured offline transport' }, 500);
  };
  const runtimeOptions = { name: 'existing-ux-scenario', modules: true, script, compatibilityDate: '2024-01-01',
    compatibilityFlags: ['nodejs_compat'], outboundService, kvNamespaces: ['TG_SLICE', 'SESSIONS'],
    kvPersist: join(persistRoot, 'kv'), durableObjectsPersist: join(persistRoot, 'do'),
    bindings: Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === 'string')),
    durableObjects: { INTAKE: { className: 'IntakeBuffer', useSQLite: true },
      TG_DELIVERY_OWNER: { className: 'TgDeliveryOwner', useSQLite: true } },
  };
  let runtime;
  const webhook = (update, signed = true) => runtime.dispatchFetch('https://worker.test/webhook', {
    method: 'POST', headers: { 'content-type': 'application/json',
      ...(signed ? { 'x-telegram-bot-api-secret-token': env.TELEGRAM_WEBHOOK_SECRET } : {}) },
    body: JSON.stringify(update),
  });
  const message = (messageId, text, senderId = 43) => ({ update_id: messageId,
    message: { message_id: messageId, date: 1791190800, chat: { id: 42, type: 'private' },
      from: { id: senderId, is_bot: false }, text } });
  const collector = async () => {
    const namespace = await runtime.getDurableObjectNamespace('INTAKE');
    return namespace.get(namespace.idFromName('42'));
  };
  const state = async (alarm = false) => {
    const response = await (await collector()).fetch(`https://intake/${alarm ? 'scenario-alarm' : 'scenario-state'}`, {
      headers: { 'x-scenario-probe': 'offline-probe' },
    });
    expect(response.status).toBe(200);
    const observed = await response.json();
    expect(observed.sqliteWitness).toBe(1);
    return new Map(observed.entries);
  };
  const terminalProof = async () => {
    const terminalMessages = providerMessages.filter(item => item.text === 'Offline engine fixture completed.');
    expect(terminalMessages).toHaveLength(1);
    expect(terminalMessages[0].chat_id).toBe(42);
    const providerMessageId = 501 + providerMessages.indexOf(terminalMessages[0]);
    const response = await runtime.dispatchFetch('https://worker.test/deliveries/ut-workerd-scenario', {
      headers: { 'x-telegram-bot-api-secret-token': env.TELEGRAM_WEBHOOK_SECRET },
    });
    expect(response.status).toBe(200);
    const delivery = await response.json();
    expect(delivery.receipt).toBeNull();
    expect(delivery.terminal).toMatchObject({ deliveryId: 'terminal:ut-workerd-scenario:g1',
      userTaskId: 'ut-workerd-scenario', generation: 1, status: 'sent', attempts: 1,
      providerMessageId, chatId: 42, threadId: null });
    return delivery.terminal;
  };
  try {
    runtime = new Miniflare(runtimeOptions);
    expect((await webhook(message(100, 'Unsigned'), false)).status).toBe(401);
    expect((await webhook(message(101, 'Wrong owner', 999))).status).toBe(403);
    expect((await webhook(message(102, 'category,amount\nfood,100\nfood,50'))).status).toBe(200);
    expect((await webhook(message(103, 'travel,275'))).status).toBe(200);
    expect((await webhook(message(103, 'travel,275'))).status).toBe(200);
    expect(cpIntakes).toHaveLength(0);
    expect(cpRoutes).toHaveLength(0);
    expect((await state()).get('buf')).toHaveLength(2);
    const receiptDue = (await state()).get('receiptDue');
    expect(receiptDue).toBeTypeOf('number');
    await new Promise(resolveWait => setTimeout(resolveWait, Math.max(0, receiptDue - Date.now()) + 50));
    await state(true);
    await workerdWaitFor(() => providerMessages.length === 1);
    const collectorId = 501;
    expect(cpIntakes).toHaveLength(0);
    expect((await webhook(message(104, 'Write outputs/category-results.csv'))).status).toBe(200);
    const editDue = (await state()).get('receiptDue');
    expect(editDue).toBeTypeOf('number');
    await new Promise(resolveWait => setTimeout(resolveWait, Math.max(0, editDue - Date.now()) + 50));
    await state(true);
    await workerdWaitFor(() => providerEdits.some(edit => edit.message_id === collectorId));
    expect(providerMessages).toHaveLength(1);
    expect(cpIntakes).toHaveLength(0);
    const launch = ['vertical', 'collector-cleanup'].includes(boundary) ? message(105, 'запускай')
      : { update_id: 105, callback_query: { id: 'workerd-launch', from: { id: 43, is_bot: false },
        data: 'intake_run', message: { message_id: collectorId, chat: { id: 42, type: 'private' } } } };
    expect((await webhook(launch)).status).toBe(200);
    expect(cpIntakes).toHaveLength(1);
    expect(admitted.inputItems.map(item => item.text)).toEqual([
      'category,amount\nfood,100\nfood,50', 'travel,275', 'Write outputs/category-results.csv',
      ...(['vertical', 'collector-cleanup'].includes(boundary) ? ['запускай'] : []),
    ]);
    expect(admitted.sessionId).toBe('workerd-source-session');
    const snapshotResponse = await (await collector()).fetch(`https://intake/input?messageId=${collectorId}&username=integrator`);
    expect(snapshotResponse.status).toBe(200);
    const snapshot = await snapshotResponse.json();
    expect(snapshot.body.controlPlaneEnvelope).toEqual(admitted);
    const before = await state();
    expect(before.get('busy')).toBe(true);
    const accepted = before.get(`cp-acceptance:${admitted.requestId}`);
    if (boundary === 'vertical' || boundary === 'collector-cleanup') {
      expect(accepted.receipt.userTaskId).toBe('ut-workerd-scenario');
      expect(cpRoutes).toEqual([{ taskId: 'ut-workerd-scenario', continue: true }]);
      expect(dispatchCount).toBe(1);
      if (boundary === 'collector-cleanup') {
        expect(snapshot.body.initialMsgId).toBe(collectorId);
        await runtime.dispose();
        runtime = new Miniflare(runtimeOptions);
        expect((await state()).get('busy')).toBe(true);
      }
      completedTasks.add('ut-workerd-scenario');
      const reconciled = await runtime.dispatchFetch('https://worker.test/scenario-reconcile', {
        headers: { 'x-scenario-probe': 'offline-probe' },
      });
      expect(reconciled.status).toBe(200);
      await workerdWaitFor(() => providerMessages.some(item => item.text === 'Offline engine fixture completed.'));
      await terminalProof();
      if (boundary === 'collector-cleanup') {
        await state(true);
        const finalized = providerEdits.filter(edit => edit.message_id === collectorId
          && edit.text === '✅ Готово. Результат отправлен отдельным сообщением.');
        expect(finalized).toHaveLength(1);
        expect(finalized[0].reply_markup).toEqual({ inline_keyboard: [[{ text: '📋 Посмотреть input', callback_data: 'input_run' }]] });
        const terminal = await terminalProof();
        await runtime.dispose();
        runtime = new Miniflare(runtimeOptions);
        await state(true);
        expect((await webhook(launch)).status).toBe(200);
        expect(await terminalProof()).toEqual(terminal);
        expect(providerEdits.filter(edit => edit.message_id === collectorId
          && edit.text === finalized[0].text)).toHaveLength(1);
        expect(cpIntakes).toHaveLength(1);
        expect(dispatchCount).toBe(1);
        expect(providerMessages).toHaveLength(2);
        const restored = await (await collector()).fetch(`https://intake/input?messageId=${collectorId}&username=integrator`);
        expect(await restored.json()).toEqual(snapshot);
      }
      expect(legacyRequests).toEqual([]);
      expect(unexpectedRequests).toEqual([]);
      return;
    }
    if (boundary === 'stop' || boundary === 'stop-disabled') {
      expect(accepted.receipt.userTaskId).toBe('ut-workerd-scenario');
      expect(cpRoutes).toContainEqual({ taskId: 'ut-workerd-scenario', continue: true });
      const intake = await collector();
      expect((await intake.fetch('https://intake/stop', { method: 'POST',
        body: JSON.stringify({ username: 'integrator', chatId: 42, threadId: null }) })).status).toBe(200);
      if (boundary === 'stop-disabled') {
        expect((await webhook(message(106, 'Preserved additional input during pending stop'))).status).toBe(200);
        const pending = await state();
        expect(pending.get('cpStopWindow').pending).toBe(true);
        expect(pending.get('buf')).toHaveLength(1);
        await runtime.dispose();
        runtime = new Miniflare({ ...runtimeOptions,
          bindings: { ...runtimeOptions.bindings, TG_SLICE_STOP_ENABLED: 'false' } });
        const restored = await collector();
        for (const path of ['/stop', '/cp-stop-targets']) {
          expect((await restored.fetch(`https://intake${path}`, { method: 'POST',
            body: JSON.stringify({ username: 'integrator', chatId: 42, threadId: null }) })).status).toBe(409);
        }
        completedTasks.add('ut-workerd-scenario');
        const due = (await state()).get('receiptDue');
        if (due) await new Promise(resolveWait => setTimeout(resolveWait, Math.max(0, due - Date.now()) + 50));
        await state(true);
        const delivered = await terminalProof();
        const after = await state();
        expect(after.get('cpStopWindow')).toEqual(pending.get('cpStopWindow'));
        expect(after.get('buf')).toEqual(pending.get('buf'));
        expect(after.get('stopped')).toBe(pending.get('stopped'));
        expect(after.get('busy')).toBeUndefined();
        await state(true);
        expect(await terminalProof()).toEqual(delivered);
        expect(cpStopRequests).toEqual([]);
        expect(cpIntakes).toHaveLength(1);
        expect(cpRoutes).toHaveLength(1);
        expect(dispatchCount).toBe(1);
        expect(legacyRequests).toEqual([]);
        expect(unexpectedRequests).toEqual([]);
        return;
      }
      expect((await intake.fetch('https://intake/cp-stop-targets', { method: 'POST',
        body: JSON.stringify({ username: 'integrator', chatId: 42, threadId: null }) })).status).toBe(200);
      expect(cpStopRequests).toHaveLength(1);
      expect(cpStopRequests[0]).toMatchObject({ profileId: env.CONTROL_PLANE_PROFILE,
        conversationId: admitted.conversationRef, admissionBarrierComplete: true,
        admissionRequestIds: [admitted.requestId], restart: false });
      expect(cpStopRequests[0]).not.toHaveProperty('chatId');
      expect(cpStopRequests[0]).not.toHaveProperty('username');
      const stopped = (await state()).get('cpStopWindow');
      expect(stopped).toMatchObject({ pending: false, unresolved: false, stopConfirmed: true,
        tasks: [{ requestId: admitted.requestId, userTaskId: 'ut-workerd-scenario', profileId: env.CONTROL_PLANE_PROFILE }] });
      expect(legacyRequests).toEqual([]);
      expect(unexpectedRequests).toEqual([]);
      return;
    }
    if (boundary === 'route') expect(accepted.receipt.userTaskId).toBe('ut-workerd-scenario');
    else expect(accepted).toBeUndefined();
    await runtime.dispose();
    runtime = new Miniflare(runtimeOptions);
    const restored = await state();
    expect(restored.get('busy')).toBe(true);
    expect(restored.get(`cp-acceptance:${admitted.requestId}`)).toEqual(accepted);
    const recoveredSnapshot = await (await collector()).fetch(`https://intake/input?messageId=${collectorId}&username=integrator`);
    expect(await recoveredSnapshot.json()).toEqual(snapshot);
    await state(true);
    expect((await webhook(launch)).status).toBe(200);
    expect(cpIntakes).toHaveLength(boundary === 'intake' ? 2 : 1);
    for (const envelope of cpIntakes) expect(envelope).toEqual(admitted);
    const collectorMessages = providerMessages.filter(item => item.reply_markup?.inline_keyboard?.flat()
      .some(button => button.callback_data === 'intake_run'));
    expect(collectorMessages).toHaveLength(1);
    const unknownNotices = providerMessages.filter(item => item.text.includes('Подтверждение не получено'));
    expect(unknownNotices).toHaveLength(boundary === 'intake' ? 1 : 0);
    expect(unknownNotices.map(item => item.text)).toEqual(boundary === 'intake'
      ? ['⚠️ Подтверждение не получено; сверяю ту же задачу. Собранный ввод сохранён.'] : []);
    for (const notice of unknownNotices) expect(notice.reply_markup).toBeUndefined();
    expect(providerMessages).toHaveLength(1 + unknownNotices.length);
    expect(legacyRequests).toEqual([]);
    expect(unexpectedRequests).toEqual([]);
    expect(cpRoutes.length).toBeGreaterThanOrEqual(boundary === 'route' ? 2 : 1);
    for (const route of cpRoutes) expect(route).toMatchObject({ taskId: 'ut-workerd-scenario', continue: true });
    expect(dispatchedTasks.has('ut-workerd-scenario')).toBe(true);
    expect(dispatchCount).toBe(1);
    const recovered = await state();
    expect(recovered.get('launching')).toBeUndefined();
    expect(recovered.get(`cp-acceptance:${admitted.requestId}`).receipt.userTaskId).toBe('ut-workerd-scenario');
    expect(admittedTasks.size).toBe(1);
    for (const update of [message(102, 'category,amount\nfood,100\nfood,50'),
      message(103, 'travel,275'), message(104, 'Write outputs/category-results.csv')]) {
      expect((await webhook(update)).status).toBe(200);
    }
    expect((await state()).get('buf') || []).toEqual([]);
    completedTasks.add('ut-workerd-scenario');
    await state(true);
    expect((await state()).get('busy')).toBeUndefined();
    await workerdWaitFor(() => providerMessages.some(item => item.text === 'Offline engine fixture completed.'));
    const terminalBeforeFollowup = await terminalProof();
    expect((await webhook(message(106, 'Continue with the same input and session'))).status).toBe(200);
    const followupDue = (await state()).get('receiptDue');
    expect(followupDue).toBeTypeOf('number');
    await new Promise(resolveWait => setTimeout(resolveWait, Math.max(0, followupDue - Date.now()) + 50));
    await state(true);
    const allCollectors = providerMessages.filter(item => item.reply_markup?.inline_keyboard?.flat()
      .some(button => button.callback_data === 'intake_run'));
    expect(allCollectors).toHaveLength(2);
    expect(providerMessages.filter(item => item.text.includes('Подтверждение не получено'))).toEqual(unknownNotices);
    expect(providerMessages).toHaveLength(allCollectors.length + unknownNotices.length + 1);
    expect(await terminalProof()).toEqual(terminalBeforeFollowup);
    const followupCollectorId = 501 + providerMessages.indexOf(allCollectors[1]);
    const followupLaunch = { update_id: 107, callback_query: { id: 'workerd-followup-launch',
      from: { id: 43, is_bot: false }, data: 'intake_run',
      message: { message_id: followupCollectorId, chat: { id: 42, type: 'private' } } } };
    expect((await webhook(followupLaunch)).status).toBe(200);
    expect(admittedTasks.size).toBe(2);
    const followup = [...admittedTasks.values()].find(task => task.taskId === 'ut-workerd-followup');
    expect(followup.envelope.requestId).not.toBe(admitted.requestId);
    expect(followup.envelope.conversationRef).toBe(admitted.conversationRef);
    expect(followup.envelope.inputItems).toEqual([{ text: 'Continue with the same input and session', artifactRefs: [] }]);
    expect(followup.envelope.sessionId).toBe(admitted.sessionId);
    expect(dispatchCount).toBe(2);
    expect((await webhook(followupLaunch)).status).toBe(200);
    expect(admittedTasks.size).toBe(2);
    expect(dispatchCount).toBe(2);
    expect(await terminalProof()).toEqual(terminalBeforeFollowup);
    expect(providerMessages.filter(item => item.reply_markup?.inline_keyboard?.flat()
      .some(button => button.callback_data === 'intake_run'))).toHaveLength(2);
    expect(providerMessages).toHaveLength(3 + unknownNotices.length);
    expect(legacyRequests).toEqual([]);
    expect(unexpectedRequests).toEqual([]);
  } finally {
    if (runtime) await runtime.dispose();
    await rm(persistRoot, { recursive: true, force: true });
  }
}, 30000);
