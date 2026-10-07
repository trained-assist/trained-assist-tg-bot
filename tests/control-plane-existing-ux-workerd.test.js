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
      import worker, { IntakeBufferReset as RealIntakeBuffer, TgDeliveryOwner } from './src/sandbox-tg/existing-ux.js';
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
            const { intent, alarmAt, busy, stopWindow } = await request.json();
            await this.state.storage.put('cpCollectorCleanupRequests', [intent.requestId]);
            await this.state.storage.put('cp-collector-cleanup:' + intent.requestId, intent);
            await this.state.storage.put('input-message:' + intent.messageId, intent.requestId);
            if (busy) await this.state.storage.put('busy', true);
            if (stopWindow) await this.state.storage.put('cpStopWindow', stopWindow);
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
          if (path === '/scenario-seed-pending-unsupported') {
            if (request.headers.get('x-scenario-probe') !== 'offline-probe') return new Response(null, { status: 401 });
            const item = { text: '', msg: { message_id: 7, chat: { id: 42 }, voice: { file_id: 'offline-voice' } } };
            const launchKey = JSON.stringify([7]);
            await this.state.storage.put('busy', true);
            await this.state.storage.put('busyChatId', 42);
            await this.state.storage.put('cpUnresolvedLaunches', [launchKey]);
            await this.state.storage.put('cpBusyRequests', ['accepted-voice-request']);
            await this.state.storage.put('cp-acceptance:accepted-voice-request', { terminal: false,
              receipt: { requestId: 'accepted-voice-request', userTaskId: 'ut-accepted-voice',
                profileId: 'workerd-profile', durable: true, providerAcceptedAt: Date.now() } });
            await this.state.storage.put('cp-launch:' + launchKey, { msg: { ...item.msg, intakeItems: [item] },
              snapshotRequestId: 'accepted-voice-request', profileId: 'workerd-profile', botUsername: 'probability_cat_bot' });
            return Response.json({ seeded: true });
          }
          if (path === '/scenario-seed-pending-launching') {
            if (request.headers.get('x-scenario-probe') !== 'offline-probe') return new Response(null, { status: 401 });
            const item = { text: '', msg: { message_id: 7, chat: { id: 42 }, voice: { file_id: 'offline-voice' } } };
            await this.state.storage.put('busy', true);
            await this.state.storage.put('busyChatId', 42);
            await this.state.storage.put('cpStopWindow', { pending: true, intentId: 'scenario-stop-window' });
            await this.state.storage.put('launching', [item]);
            return Response.json({ seeded: true });
          }
          if (path === '/scenario-seed-pending-launching-lost-busy') {
            if (request.headers.get('x-scenario-probe') !== 'offline-probe') return new Response(null, { status: 401 });
            const item = { text: '', msg: { message_id: 7, chat: { id: 42 }, voice: { file_id: 'offline-voice' } } };
            await this.state.storage.put('cpStopWindow', { pending: true, intentId: 'scenario-stop-window' });
            await this.state.storage.put('launching', [item]);
            return Response.json({ seeded: true });
          }
          if (path === '/scenario-seed-pending-stop-no-launch') {
            if (request.headers.get('x-scenario-probe') !== 'offline-probe') return new Response(null, { status: 401 });
            await this.state.storage.put('cpStopWindow', { pending: true, unresolved: true,
              stopConfirmed: false, intentId: 'scenario-stop-window', admissionLaunchKeys: ['[7]'],
              admissionRequestIds: ['old-request'], tasks: [{ requestId: 'old-request', userTaskId: 'ut-workerd-old' }] });
            await this.state.storage.put('busy', true);
            await this.state.storage.put('busyChatId', 42);
            await this.state.storage.put('busySince', Date.now() - 60000);
            await this.state.storage.put('cpBusyRequests', ['old-request']);
            await this.state.storage.put('cp-acceptance:old-request', { receipt: { requestId: 'old-request',
              userTaskId: 'ut-workerd-old', profileId: 'workerd-profile' }, terminal: false });
            await this.state.storage.put('cpUnresolvedLaunches', ['[7]']);
            await this.state.storage.put('cp-launch:[7]', { userDismissed: false,
              snapshotRequestId: 'old-request', profileId: 'workerd-profile',
              botUsername: 'probability_cat_bot',
              msg: { message_id: 7, chat: { id: 42 }, text: 'old task' } });
            return Response.json({ seeded: true });
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
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Local workerd scenario observation timed out');
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
}

it.each(['idle', 'stop-disabled', 'busy'])('cold SQLite cleanup preserves a real earlier Durable Object alarm through the %s branch', async branch => {
  const persistRoot = await mkdtemp(join(tmpdir(), 'tg-cleanup-alarm-workerd-'));
  const env = makeEnv({ EXECUTION_BACKEND: 'control-plane', CONTROL_PLANE_URL: 'https://cp.test',
    TG_SLICE_STOP_ENABLED: 'false' });
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
    const stopWindow = branch === 'stop-disabled' ? { pending: true, intentId: 'deferred-stop' } : null;
    expect(await probe('scenario-cleanup-prepare', { intent, alarmAt, busy: branch === 'busy', stopWindow })).toEqual({ alarmAt });
    await runtime.dispose();
    runtime = new Miniflare(options);
    expect((await probe('scenario-state')).alarmAt).toBe(alarmAt);
    const after = await probe('scenario-alarm');
    expect(after.sqliteWitness).toBe(1);
    expect(edits).toHaveLength(1);
    expect(after.alarmAt).toBe(alarmAt);
    expect(new Map(after.entries).get('cp-collector-cleanup:' + intent.requestId)).toEqual(intent);
    expect(new Map(after.entries).get('cpCollectorCleanupRequests')).toEqual([intent.requestId]);
    if (stopWindow) expect(new Map(after.entries).get('cpStopWindow')).toEqual(stopWindow);
    if (branch === 'busy') expect(new Map(after.entries).get('busy')).toBe(true);
  } finally {
    await runtime.dispose();
    await rm(persistRoot, { recursive: true, force: true });
  }
});

it.each(['vertical', 'route', 'intake', 'stop', 'stop-disabled', 'collector-cleanup', 'stop-unconfirmed-new', 'unknown-run', 'failed-task', 'pending-unsupported-cold', 'pending-unsupported-launching', 'pending-unsupported-launching-lost-busy', 'pending-stop-no-launch'])('real signed workerd SQLite existing UX scenario: %s', async boundary => {
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
    AGENT_SECRET: 'offline-legacy-secret', CONTROL_PLANE_SESSION_ID: 'workerd-source-session',
    TG_SLICE_STOP_ENABLED: 'true', TEST_CHAT_IDS: '', CONTROL_PLANE_PRINCIPAL_SIGNATURE: 'test-signature',
    SESSION_NAMESPACE: 'integrator-existing-ux-v1' });
  const providerMessages = [];
  const providerEdits = [];
  const telegramTimeline = [];
  const cpIntakes = [];
  const cpRoutes = [];
  const cpStopRequests = [];
  const legacyRequests = [];
  const admittedTasks = new Map();
  const dispatchedTasks = new Set();
  const completedTasks = new Set();
  const unknownTasks = new Set();
  const failedTasks = new Set();
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
        const messageId = 500 + providerMessages.length;
        telegramTimeline.push({ method: 'send', messageId, body });
        return reply({ ok: true, result: { message_id: messageId, date: 1791190800 } });
      }
      if (url.pathname === `/bot${env.TG_SANDBOX_BOT_TOKEN}/editMessageText`) {
        providerEdits.push(body);
        telegramTimeline.push({ method: 'edit', messageId: body.message_id, body });
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
        acceptedAt: Date.now(), durable: true, duplicate }, duplicate ? 200 : 201);
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
    if (url.hostname === 'cp.test' && (url.pathname === '/cp-stop-targets' || url.pathname === '/control-plane/cp-stop-targets')) {
      cpStopRequests.push(body);
      const tasks = body.admissionRequestIds.map(requestId => {
        const entry = [...admittedTasks.values()].find(value => value.envelope.requestId === requestId);
        return { requestId, userTaskId: entry?.taskId, profileId: body.profileId, receiptId: `receipt-${entry?.taskId}` };
      });
      return reply({ snapshotId: `stop-${cpStopRequests.length}`, profileId: body.profileId,
        conversationId: body.conversationId, tasks,
        unresolved: boundary === 'stop-unconfirmed-new',
        stopConfirmed: boundary !== 'stop-unconfirmed-new',
        reason: boundary === 'stop-unconfirmed-new' ? 'native_stop_unknown' : null });
    }
    if (url.hostname === 'cp.test' && url.pathname === '/stop-targets') return reply({
      snapshotId: 'workerd-stop-unconfirmed', profileId: body.profileId,
      conversationId: body.conversationId,
      tasks: body.admissionRequestIds.map(requestId => ({ requestId,
        userTaskId: 'ut-workerd-scenario', profileId: body.profileId })),
      unresolved: true, stopConfirmed: false, reason: 'native_stop_unknown',
    });
    if (url.hostname === 'cp.test' && url.pathname === '/stop') return reply({ killed: 0 });
    if (url.hostname === 'cp.test' && url.pathname === '/status') return reply({
      taskStore: { id: body.taskId, profile_id: env.CONTROL_PLANE_PROFILE,
        status: completedTasks.has(body.taskId) ? 'done' : unknownTasks.has(body.taskId) ? 'running'
          : failedTasks.has(body.taskId) ? 'failed' : 'active', generation: 1,
        result: completedTasks.has(body.taskId) ? { answer: 'Offline engine fixture completed.' } : null },
      runs: dispatchedTasks.has(body.taskId) ? [{ id: `run-${body.taskId}`,
        status: completedTasks.has(body.taskId) ? 'done' : unknownTasks.has(body.taskId) ? 'unknown'
          : failedTasks.has(body.taskId) ? 'failed' : 'running', generation: 1 }] : [],
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
    bindings: Object.fromEntries(Object.entries({ ...env, TEST_CHAT_IDS: '' })
      .filter(([, value]) => typeof value === 'string')),
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
  const visibleTelegramMessages = () => {
    const messages = new Map();
    for (const entry of telegramTimeline) {
      const previous = messages.get(entry.messageId) || {};
      messages.set(entry.messageId, { ...previous, ...entry.body,
        reply_markup: entry.body.reply_markup ?? previous.reply_markup });
    }
    return [...messages].map(([messageId, body]) => ({ messageId, body }));
  };
  const latestTelegramButton = callbackData => visibleTelegramMessages().reverse()
    .find(entry => entry.body.reply_markup?.inline_keyboard?.flat()
      .some(button => callbackData.endsWith('|')
        ? button.callback_data.startsWith(callbackData) : button.callback_data === callbackData));
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
    if (boundary === 'pending-unsupported-cold' || boundary === 'pending-unsupported-launching' ||
        boundary === 'pending-unsupported-launching-lost-busy' || boundary === 'pending-stop-no-launch') {
      if (boundary === 'pending-stop-no-launch') admittedTasks.set('workerd-profile:old-request', {
        envelope: { profileId: 'workerd-profile', requestId: 'old-request' }, taskId: 'ut-workerd-old' });
      const seedPath = boundary === 'pending-unsupported-cold'
        ? 'scenario-seed-pending-unsupported'
        : boundary === 'pending-unsupported-launching-lost-busy'
          ? 'scenario-seed-pending-launching-lost-busy'
          : boundary === 'pending-stop-no-launch' ? 'scenario-seed-pending-stop-no-launch'
            : 'scenario-seed-pending-launching';
      const seeded = await (await collector()).fetch(`https://intake/${seedPath}`, {
        headers: { 'x-scenario-probe': 'offline-probe' },
      });
      expect(seeded.status).toBe(200);
      await runtime.dispose();
      runtime = new Miniflare(runtimeOptions);

      const testText = boundary === 'pending-stop-no-launch' ? 'обычный текст после остановки' : 'новый текст после голосового';
      const acceptedText = await webhook(message(8, testText));
      expect(acceptedText.status).toBe(200);
      expect(await acceptedText.json()).toMatchObject({ ok: true, buffered: 1 });
      const recoveredState = await state();
      if (boundary === 'pending-unsupported-cold') expect(recoveredState.get('cpUnresolvedLaunches')).toEqual(['[7]']);
      else if (boundary === 'pending-stop-no-launch') expect(recoveredState.get('cpUnresolvedLaunches')).toEqual(['[7]']);
      else expect(recoveredState.get('cpUnresolvedLaunches')).toBeUndefined();
      if (boundary === 'pending-unsupported-launching-lost-busy') expect(recoveredState.get('busy')).toBeUndefined();
      else expect(recoveredState.get('busy')).toBe(true);
      if (boundary === 'pending-unsupported-cold' || boundary === 'pending-stop-no-launch') expect(recoveredState.get('launching')).toBeUndefined();
      else expect(recoveredState.get('launching')).toHaveLength(1);
      expect(recoveredState.get('buf').map(item => item.text)).toEqual([testText]);
      if (boundary === 'pending-unsupported-cold') {
        expect(providerMessages.some(item => item.text.includes('Текст сохранил в отдельной отложенной порции'))).toBe(true);
      } else if (boundary === 'pending-stop-no-launch') {
        expect(providerMessages.some(item => item.text.includes('Текст сохранил отдельно'))).toBe(true);
        expect(latestTelegramButton('ws|auto|')).toBeDefined();
        const beforeLaunchCount = cpIntakes.length;
        const runButton = latestTelegramButton('ws|auto|');
        expect(runButton).toBeDefined();
        const independentLaunch = await webhook({ update_id: 9, callback_query: { id: 'workerd-independent-launch',
          from: { id: 43, is_bot: false }, data: runButton.body.reply_markup.inline_keyboard.flat()
            .find(button => button.callback_data.startsWith('ws|auto|')).callback_data,
          message: { message_id: runButton.messageId, chat: { id: 42, type: 'private' } } } });
        expect(independentLaunch.status).toBe(200);
        expect(cpIntakes).toHaveLength(beforeLaunchCount + 1);
        expect(cpIntakes.at(-1).inputItems.map(item => item.text)).toEqual([testText]);
        expect(providerMessages.some(item => item.text.includes('Запускаю параллельно — новая сессия'))).toBe(true);
        expect(admittedTasks.get(`${env.CONTROL_PLANE_PROFILE}:${cpIntakes.at(-1).requestId}`).taskId).not.toBe('ut-workerd-old');
        const launchedState = await state();
        expect(launchedState.get('cpStopWindow')).toMatchObject({ pending: true,
          intentId: 'scenario-stop-window', admissionLaunchKeys: ['[7]'],
          admissionRequestIds: ['old-request'], tasks: [{ requestId: 'old-request', userTaskId: 'ut-workerd-old' }] });
        expect(launchedState.get('cpUnresolvedLaunches')).toEqual(['[7]']);
        const sessionRecords = [...launchedState].filter(([key]) => key.startsWith('cp-session:')).map(([, value]) => value);
        expect(sessionRecords).toHaveLength(1);
        expect(sessionRecords[0].sessionId).not.toBe('workerd-source-session');
        expect(cpIntakes).toHaveLength(beforeLaunchCount + 1);
        return;
      } else expect(providerMessages.some(item => item.text.includes('Текст сохранил в отдельной отложенной порции'))).toBe(true);
      expect(providerMessages.some(item => item.text.includes('Предыдущая порция ещё сверяется с запуском'))).toBe(false);
      expect(cpIntakes).toEqual([]);
      expect(legacyRequests).toEqual([]);
      expect(unexpectedRequests).toEqual([]);
      return;
    }
    expect((await webhook(message(100, 'Unsigned'), false)).status).toBe(401);
    expect((await webhook(message(101, 'Wrong owner', 999))).status).toBe(403);
    expect((await webhook(message(102, 'category,amount\nfood,100\nfood,50'))).status).toBe(200);
    expect((await webhook(message(103, 'travel,275'))).status).toBe(200);
    expect((await webhook(message(103, 'travel,275'))).status).toBe(200);
    expect(cpIntakes).toHaveLength(0);
    expect(cpRoutes).toHaveLength(0);
    expect((await state()).get('buf')).toHaveLength(2);
    await workerdWaitFor(async () => typeof (await state()).get('receiptDue') === 'number');
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
    const launchRevision = (await state()).get('draftRevision');
    const launch = boundary === 'vertical' ? message(105, 'запускай')
      : { update_id: 105, callback_query: { id: 'workerd-launch', from: { id: 43, is_bot: false },
        data: `ws|auto|${launchRevision}`, message: { message_id: collectorId, chat: { id: 42, type: 'private' } } } };
    expect((await webhook(launch)).status).toBe(200);
    expect(cpIntakes).toHaveLength(1);
    expect(admitted.inputItems.map(item => item.text)).toEqual([
      'category,amount\nfood,100\nfood,50', 'travel,275', 'Write outputs/category-results.csv',
      ...(boundary === 'vertical' ? ['запускай'] : []),
    ]);
    expect(admitted).toMatchObject({ workStyle: boundary === 'vertical' ? 'auto' : 'auto',
      workStyleSource: boundary === 'vertical' ? 'default' : 'explicit' });
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
    if (boundary === 'unknown-run' || boundary === 'failed-task') {
      if (boundary === 'unknown-run') unknownTasks.add('ut-workerd-scenario');
      else failedTasks.add('ut-workerd-scenario');
      expect((await webhook(message(106, 'Следующая самостоятельная задача'))).status).toBe(200);
      expect((await state()).get('buf')).toHaveLength(1);
      await state(true);
      await state(true);
      const afterWeirdStatus = await state();
      expect(afterWeirdStatus.get('busy')).toBeUndefined();
      expect((await state()).get(`cp-acceptance:${admitted.requestId}`)).toMatchObject(boundary === 'unknown-run'
        ? { outcomeUnknown: true, terminal: false } : { terminal: true });
      expect(cpIntakes).toHaveLength(1);
      expect((await webhook(message(107, 'Запустить агента'))).status).toBe(200);
      expect(cpIntakes).toHaveLength(2);
      expect(cpIntakes[1].inputItems.map(item => item.text)).toEqual([
        'Следующая самостоятельная задача', 'Запустить агента',
      ]);
      expect(admittedTasks.get(`${env.CONTROL_PLANE_PROFILE}:${cpIntakes[1].requestId}`).taskId).toBe('ut-workerd-followup');
      expect(cpRoutes.filter(route => route.taskId === 'ut-workerd-scenario')).toHaveLength(1);
      expect(cpRoutes.filter(route => route.taskId === 'ut-workerd-followup')).toEqual([
        { taskId: 'ut-workerd-followup', continue: true },
      ]);
      completedTasks.add('ut-workerd-followup');
      await state(true);
      await workerdWaitFor(() => providerMessages.some(item => item.text === 'Offline engine fixture completed.'));
      const deliveredTask = await runtime.dispatchFetch('https://worker.test/deliveries/ut-workerd-followup', {
        headers: { 'x-telegram-bot-api-secret-token': env.TELEGRAM_WEBHOOK_SECRET },
      });
      expect(deliveredTask.status).toBe(200);
      expect((await deliveredTask.json()).terminal).toMatchObject({
        deliveryId: 'terminal:ut-workerd-followup:g1', userTaskId: 'ut-workerd-followup', status: 'sent', chatId: 42,
      });
      expect(dispatchCount).toBe(2);
      expect(legacyRequests).toEqual([]);
      expect(unexpectedRequests).toEqual([]);
      return;
    }
    if (boundary === 'stop-unconfirmed-new') {
      expect(accepted.receipt.userTaskId).toBe('ut-workerd-scenario');
      expect((await webhook(message(106, 'Independent task B'))).status).toBe(200);
      const due = (await state()).get('receiptDue');
      if (due) await new Promise(resolveWait => setTimeout(resolveWait, Math.max(0, due - Date.now()) + 50));
      await state(true);
      const stopNewButton = latestTelegramButton('intake_stopnew');
      expect(stopNewButton).toBeDefined();
      const stopResponse = await webhook({ update_id: 107, callback_query: { id: 'workerd-stop-new',
        from: { id: 43, is_bot: false }, data: 'intake_stopnew',
        message: { message_id: stopNewButton.messageId, chat: { id: 42, type: 'private' } } } });
      expect(stopResponse.status).toBe(200);
      expect(await stopResponse.json()).toEqual({ ok: true });
      const confirmationButton = latestTelegramButton('intake_stopyes|new');
      expect(confirmationButton).toBeDefined();
      expect(confirmationButton.body.text).toContain('НОВОЙ задачей');
      const confirmCallback = { update_id: 108, callback_query: { id: 'workerd-stop-confirm',
        from: { id: 43, is_bot: false }, data: 'intake_stopyes|new',
        message: { message_id: confirmationButton.messageId, chat: { id: 42, type: 'private' } } } };
      expect((await webhook(confirmCallback)).status).toBe(200);
      expect(latestTelegramButton('intake_stopyes|new')).toBeUndefined();
      expect(visibleTelegramMessages().some(entry => entry.messageId === confirmationButton.messageId
        && entry.body.text.includes('старая может продолжить работу'))).toBe(true);
      expect(cpStopRequests.length).toBeGreaterThanOrEqual(1);
      for (const stopRequest of cpStopRequests) expect(stopRequest.admissionRequestIds).toEqual([admitted.requestId]);
      expect(cpIntakes).toHaveLength(2);
      const independent = cpIntakes[1];
      expect(independent.requestId).not.toBe(admitted.requestId);
      expect(independent.inputItems.map(item => item.text)).toEqual(['Independent task B']);
      expect(admittedTasks.get(`${env.CONTROL_PLANE_PROFILE}:${independent.requestId}`).taskId).toBe('ut-workerd-followup');
      expect(cpRoutes.filter(route => route.taskId === 'ut-workerd-scenario').length).toBeGreaterThanOrEqual(1);
      expect(cpRoutes.filter(route => route.taskId === 'ut-workerd-followup')).toEqual([
        { taskId: 'ut-workerd-followup', continue: true },
      ]);
      expect((await state()).get('cpStopWindow')).toMatchObject({ pending: true,
        stopConfirmed: false, admissionRequestIds: [admitted.requestId] });
      expect((await webhook({ ...confirmCallback, update_id: 109,
        callback_query: { ...confirmCallback.callback_query, id: 'workerd-stop-confirm-replay' } })).status).toBe(200);
      expect(cpIntakes).toHaveLength(2);
      expect(dispatchCount).toBe(2);
      expect(providerEdits.some(item => item.text.includes('старая может продолжить работу'))).toBe(true);
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
      .some(button => button.callback_data?.startsWith('ws|')));
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
      .some(button => button.callback_data?.startsWith('ws|')));
    expect(allCollectors).toHaveLength(2);
    expect(providerMessages.filter(item => item.text.includes('Подтверждение не получено'))).toEqual(unknownNotices);
    expect(providerMessages).toHaveLength(allCollectors.length + unknownNotices.length + 1);
    expect(await terminalProof()).toEqual(terminalBeforeFollowup);
    const followupCollectorId = 501 + providerMessages.indexOf(allCollectors[1]);
    const followupRevision = (await state()).get('draftRevision');
    const followupLaunch = { update_id: 107, callback_query: { id: 'workerd-followup-launch',
      from: { id: 43, is_bot: false }, data: `ws|explore|${followupRevision}`,
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
      .some(button => button.callback_data?.startsWith('ws|')))).toHaveLength(2);
    expect(providerMessages).toHaveLength(3 + unknownNotices.length);
    expect(legacyRequests).toEqual([]);
    expect(unexpectedRequests).toEqual([]);
  } finally {
    if (runtime) await runtime.dispose();
    await rm(persistRoot, { recursive: true, force: true });
  }
}, 30000);
