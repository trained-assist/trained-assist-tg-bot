#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const WORKER = 'https://trained-assist-tg-sandbox3.skillset-apply.workers.dev';
const PROFILE_ID = 'production-e2e-telegram-v1';
const TARGET = 'productionE2e';
let canaryProgress = {
  ok: false,
  scenario: 'production-telegram-two-turn-session-context-and-delivery',
  profileId: PROFILE_ID,
  phase: 'starting',
  turns: [],
  answerTextLogged: false,
  promptTextLogged: false,
};

async function checkpoint(phase, patch = {}) {
  canaryProgress = { ...canaryProgress, ...patch, phase };
  await writeFile('production-e2e-telegram-evidence.json', `${JSON.stringify(canaryProgress, null, 2)}\n`, { mode: 0o600 });
}

function safeTaskSummary(task, { matchedPriorNonce = false } = {}) {
  const statuses = new Set(['active', 'done', 'failed', 'cancelled']);
  const runStatuses = new Set(['queued', 'running', 'success', 'failed', 'cancelled', 'unknown']);
  const run = Array.isArray(task?.runs) ? task.runs[0] : null;
  return {
    taskId: typeof task?.userTaskId === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(task.userTaskId)
      ? task.userTaskId : null,
    taskStatus: statuses.has(task?.status) ? task.status : null,
    runCount: Array.isArray(task?.runs) ? task.runs.length : 0,
    runStatus: runStatuses.has(run?.status) ? run.status : null,
    sessionPersisted: run?.hasSessionId === true,
    resultPersisted: task?.resultPresent === true,
    answerPersisted: task?.answerPresent === true,
    answerMatchedPriorNonce: matchedPriorNonce,
    startTimePersisted: run?.hasStartedAt === true,
    finishTimePersisted: run?.hasFinishedAt === true,
    eventTypes: (task?.historyTypes ?? []).filter(type => typeof type === 'string' && /^[a-z0-9_-]{1,80}$/i.test(type)),
  };
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_required`);
  return value;
}

function identity() {
  const chatId = Number(required('TG_SANDBOX_E2E_CHAT_ID'));
  const userId = Number(required('TG_SANDBOX_E2E_USER_ID'));
  assert.equal(chatId, 1714048, 'production_canary_chat_mismatch');
  assert.equal(userId, 1714048, 'production_canary_user_mismatch');
  return { chatId, userId };
}

async function workerRequest(path, body) {
  const method = body === undefined ? 'GET' : 'POST';
  const response = await fetch(`${WORKER}${path}`, { method,
    headers: { authorization: `Bearer ${required('TG_SANDBOX3_OPERATOR_TOKEN')}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    // Keep production canary failures actionable without logging the captured
    // transcript, which can contain temporary credentials or user input.
    const safeCode = typeof payload.code === 'string' && /^[a-z0-9_-]{1,80}$/i.test(payload.code)
      ? payload.code.toLowerCase() : null;
    const safeError = typeof payload.error === 'string' && /^[a-z0-9_-]{1,80}$/i.test(payload.error)
      ? payload.error.toLowerCase() : 'failed';
    const innerStatus = Number.isSafeInteger(payload.status) ? `webhook_${payload.status}` : null;
    const suffix = [innerStatus, safeCode].filter(Boolean).join('_');
    throw new Error(`worker_${path.replaceAll('/', '_').toLowerCase()}_${response.status}_${safeError}${suffix ? `_${suffix}` : ''}`);
  }
  return payload;
}

async function send(text, extra = {}) {
  const { chatId, userId } = identity();
  return workerRequest('/operator/test-update', { target: TARGET, type: 'message', chatId, userId,
    delivery: 'telegram', text, updateId: Date.now() + Math.floor(Math.random() * 1000), ...extra });
}

async function capture(text, extra = {}) {
  const { chatId, userId } = identity();
  return workerRequest('/operator/test-update', { target: TARGET, type: 'message', chatId, userId,
    delivery: 'capture', text, updateId: Date.now() + Math.floor(Math.random() * 1000), ...extra });
}

async function pressCurrentLaunchButton() {
  const { chatId, userId } = identity();
  const deadline = Date.now() + 60_000;
  let lastCode = 'unknown';
  while (Date.now() < deadline) {
    const response = await fetch(`${WORKER}/operator/test-update`, { method: 'POST',
      headers: { authorization: `Bearer ${required('TG_SANDBOX3_OPERATOR_TOKEN')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ target: TARGET, type: 'callback', chatId, userId,
        delivery: 'telegram', callbackData: 'auto', updateId: Date.now() + Math.floor(Math.random() * 1000) }),
      signal: AbortSignal.timeout(60_000) });
    const payload = await response.json().catch(() => ({}));
    if (response.ok) return payload;
    const code = typeof payload.error === 'string' ? payload.error : 'failed';
    // The Worker refuses these two states before webhook dispatch. The Intake
    // DO emits the collector button after its debounce, so retrying this
    // no-side-effect readiness response waits for the real user-facing button.
    if (response.status === 409 && ['no_current_button_message', 'no_current_button_revision'].includes(code)) {
      lastCode = code;
      await new Promise(resolve => setTimeout(resolve, 1_000));
      continue;
    }
    throw new Error(`worker_callback_${response.status}_${code}`);
  }
  throw new Error(`production_canary_collector_button_timeout_${lastCode}`);
}

async function waitForLiveLane() {
  const deadline = Date.now() + 60_000;
  let lastReadiness = null;
  while (Date.now() < deadline) {
    const evidence = await workerRequest('/operator/test-evidence');
    assert.equal(evidence.profileId, PROFILE_ID, 'production_canary_profile_mismatch');
    lastReadiness = evidence.readiness ?? {};
    if (lastReadiness.testApiEnabled === true && lastReadiness.ingressPaused === false &&
        lastReadiness.deliveryPaused === false) return evidence;
    // The live config is deployed immediately after a paused version. Allow
    // edge propagation to finish before sending any synthetic user message.
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
  throw new Error(`production_canary_lane_not_ready_test_api_${lastReadiness?.testApiEnabled ? 'on' : 'off'}_ingress_paused_${lastReadiness?.ingressPaused ? 'yes' : 'no'}_delivery_paused_${lastReadiness?.deliveryPaused ? 'yes' : 'no'}`);
}

async function waitForTask(baselineIds, startedAt, challenge) {
  const deadline = Date.now() + 8 * 60_000;
  let task = null;
  while (Date.now() < deadline) {
    const evidence = await workerRequest(`/operator/test-evidence?challenge=${encodeURIComponent(challenge)}`);
    assert.equal(evidence.profileId, PROFILE_ID, 'production_canary_profile_mismatch');
    const candidates = (evidence.tasks ?? []).filter(candidate => !baselineIds.has(candidate.userTaskId)
      && Number(candidate.acceptedAt) >= startedAt);
    // Return any terminal task so the caller can report an answer mismatch
    // immediately instead of waiting eight minutes for a matching answer.
    task = candidates.find(candidate => ['done', 'failed', 'cancelled'].includes(candidate.status)) ?? null;
    if (task && ['done', 'failed', 'cancelled'].includes(task.status)) return { task, buffer: evidence.buffer };
    await new Promise(resolve => setTimeout(resolve, 4_000));
  }
  throw new Error(`production_canary_task_timeout_${task?.status ?? 'not_admitted'}`);
}

async function waitForDelivery(taskId, chatId) {
  const deadline = Date.now() + 3 * 60_000;
  let result;
  while (Date.now() < deadline) {
    result = await workerRequest(`/operator/test-delivery/${encodeURIComponent(taskId)}`);
    if (result.terminal?.status === 'sent') {
      assert.equal(String(result.terminal.chatId), String(chatId), 'production_canary_answer_chat_mismatch');
      assert(Number.isSafeInteger(result.terminal.providerMessageId) && result.terminal.providerMessageId > 0,
        'production_canary_provider_message_id_missing');
      return result.terminal;
    }
    if (['dead', 'unknown'].includes(result.terminal?.status)) throw new Error(`production_canary_delivery_${result.terminal.status}`);
    await new Promise(resolve => setTimeout(resolve, 3_000));
  }
  throw new Error(`production_canary_delivery_timeout_${result?.terminal?.status ?? 'not_queued'}`);
}

function controlPlaneBarrierCounts(collector) {
  const barrier = collector?.controlPlaneBarrier ?? {};
  return {
    busyRequestCount: Number.isSafeInteger(barrier.busyRequestCount) ? barrier.busyRequestCount : 0,
    unresolvedLaunchCount: Number.isSafeInteger(barrier.unresolvedLaunchCount) ? barrier.unresolvedLaunchCount : 0,
  };
}

export function summarizeLaunch(launch) {
  const collector = launch?.collector ?? {};
  const barrier = controlPlaneBarrierCounts(collector);
  return {
    callbackAccepted: launch?.ok === true,
    pendingCount: Number.isSafeInteger(collector.pendingCount) ? collector.pendingCount : null,
    busy: collector.busy === true,
    launchingCount: Array.isArray(collector.launchingMessageIds) ? collector.launchingMessageIds.length : null,
    controlPlaneBarrierPresent: collector.controlPlaneBarrier !== null && collector.controlPlaneBarrier !== undefined,
    ...barrier,
  };
}

export function launchWasDispatched(launch, beforeCollector = {}) {
  const collector = launch?.collector ?? {};
  const beforeBarrier = controlPlaneBarrierCounts(beforeCollector);
  const afterBarrier = controlPlaneBarrierCounts(collector);
  return collector.pendingCount === 0 || collector.busy === true ||
    (Array.isArray(collector.launchingMessageIds) && collector.launchingMessageIds.length > 0) ||
    afterBarrier.busyRequestCount > beforeBarrier.busyRequestCount ||
    afterBarrier.unresolvedLaunchCount > beforeBarrier.unresolvedLaunchCount;
}

async function cleanupIfTerminalAndIdle(username) {
  const evidence = await workerRequest('/operator/test-evidence');
  assert.equal(evidence.profileId, PROFILE_ID, 'production_canary_cleanup_profile_mismatch');
  const tasksTerminal = (evidence.tasks ?? []).every(task => ['done', 'failed', 'cancelled'].includes(task.status));
  const buffer = evidence.buffer ?? {};
  const noDispatchInFlight = buffer.busy !== true && buffer.launching === 0 &&
    buffer.unresolvedLaunchCount === 0 && buffer.busyRequestCount === 0;
  if (!tasksTerminal || !noDispatchInFlight) {
    await checkpoint('cleanup_deferred_for_active_or_unknown_task', { cleanup: {
      ok: false, deferred: true, tasksTerminal, noDispatchInFlight,
    } });
    return false;
  }

  // The cleanup endpoint independently refuses an Intake DO with an active
  // dispatch. It clears only the pinned test chat, including a stranded
  // unlaunched draft, and leaves CP history untouched.
  const cleanup = await workerRequest('/operator/test-cleanup', {
    target: TARGET, confirm: 'CLEAN_PINNED_TEST_CHAT', username,
  });
  await checkpoint('test_profile_cleanup_complete', { cleanup: {
    ok: cleanup.ok === true,
    testProfileDeleted: cleanup.testProfileDeleted === true,
    loginSessionDeleted: cleanup.loginSessionDeleted === true,
  } });
  if (cleanup.ok !== true || cleanup.testProfileDeleted !== true || cleanup.loginSessionDeleted !== true) {
    throw new Error('production_canary_cleanup_incomplete');
  }
  return true;
}

async function main() {
  if (process.env.TG_SANDBOX_TARGET !== TARGET) throw new Error('production_canary_target_required');
  const { chatId } = identity();
  const before = await waitForLiveLane();
  if (before.buffer?.busy || before.buffer?.launching ||
      before.buffer?.unresolvedLaunchCount || before.buffer?.busyRequestCount) {
    throw new Error('production_canary_intake_not_idle');
  }
  if ((before.tasks ?? []).some(task => !['done', 'failed', 'cancelled'].includes(task.status))) {
    throw new Error('production_canary_previous_task_not_terminal');
  }
  await checkpoint('lane_ready', { priorTaskCount: (before.tasks ?? []).length, intakeIdle: true });
  const baselineIds = new Set((before.tasks ?? []).map(task => task.userTaskId));
  // A prior interrupted canary may leave only an unlaunched draft. The pinned
  // test cleanup endpoint clears this exact chat's Intake/session state and
  // refuses if the DO still has an active dispatch; CP history is untouched.
  const clean = await workerRequest('/operator/test-cleanup', {
    target: TARGET, confirm: 'CLEAN_PINNED_TEST_CHAT',
  });
  assert.equal(clean.ok, true, 'production_canary_initial_cleanup_failed');
  const cleaned = await workerRequest('/operator/test-evidence');
  assert.equal(cleaned.buffer?.pendingCount, 0, 'production_canary_buffer_not_clean');
  await checkpoint('initial_cleanup_complete', { intakeIdle: true });

  const username = `production_e2e_${randomBytes(6).toString('hex')}`;
  let task = null;
  try {
    const created = await capture(`/adduser ${username} Production E2E`, { admin: true });
    assert.equal(created.ok, true, 'production_canary_profile_create_failed');
    const text = (created.transcript ?? []).map(item => String(item.text ?? '')).join('\n');
    const password = /Пароль:\s*<code>([^<]+)<\/code>/i.exec(text)?.[1];
    assert(password, 'production_canary_profile_password_missing');

    const login = await send(`/login ${username} ${password}`);
    assert.equal(login.admission?.authenticated, true, 'production_canary_login_failed');
    await checkpoint('test_profile_authenticated', { loginAuthenticated: true });

    const nonce = `PROD-E2E-${randomBytes(8).toString('hex').toUpperCase()}`;
    const startedAt = Date.now();
    // Use a concrete user task so Communication routing cannot reasonably
    // classify an echo-only probe as the deterministic system-health quick answer.
    const question = await send(`Create a concise three-step checklist for organizing a small community event. Include this unique marker exactly once: ${nonce}`);
    assert.equal(question.ok, true, 'production_canary_question_rejected');
    await checkpoint('first_turn_accepted', { turns: [{ accepted: true,
      pendingCount: Number.isSafeInteger(question.collector?.pendingCount) ? question.collector.pendingCount : null }] });
    assert.equal(question.collector?.pendingCount, 1, 'production_canary_input_not_buffered');

    const { userId } = identity();
    const launched = await pressCurrentLaunchButton();
    assert.equal(launched.ok, true, 'production_canary_launch_callback_failed');
    const launchState = launched.collector ?? {};
    if (launchState.pendingCount !== 0 && launchState.busy !== true &&
        !(launchState.launchingMessageIds ?? []).length &&
        !(Number(launchState.controlPlaneBarrier?.busyRequestCount) > 0) &&
        !(Number(launchState.controlPlaneBarrier?.unresolvedLaunchCount) > 0)) {
      throw new Error(`production_canary_launch_not_dispatched_pending_${launchState.pendingCount ?? 'unknown'}`);
    }

    const observed = await waitForTask(baselineIds, startedAt, nonce);
    task = observed.task;
    await checkpoint('first_turn_terminal', { turns: [safeTaskSummary(task, { matchedPriorNonce: task.answerMatchesChallenge === true })] });
    assert.equal(task.status, 'done', 'production_canary_task_not_done');
    assert.equal(task.resultPresent, true, 'production_canary_result_not_persisted');
    assert.equal(task.answerPresent, true, 'production_canary_answer_not_persisted');
    assert.equal(task.answerMatchesChallenge, true, 'production_canary_answer_mismatch');
    assert.equal(task.runs?.length, 1, 'production_canary_run_count_mismatch');
    assert.equal(task.runs[0].status, 'success', 'production_canary_runner_not_successful');
    assert.equal(task.runs[0].hasSessionId, true, 'production_canary_session_not_persisted');
    assert.equal(task.runs[0].hasStartedAt, true, 'production_canary_run_start_not_persisted');
    assert.equal(task.runs[0].hasFinishedAt, true, 'production_canary_run_finish_not_persisted');
    assert((task.historyTypes ?? []).includes('run_finished'), 'production_canary_terminal_event_not_persisted');
    assert(observed.buffer?.pendingCount === 0, 'production_canary_buffer_not_drained');

    const firstTask = task;
    const firstDelivery = await waitForDelivery(firstTask.userTaskId, chatId);
    await checkpoint('first_turn_delivered', { turns: [{ ...safeTaskSummary(firstTask, { matchedPriorNonce: true }),
      deliveryStatus: firstDelivery.status, providerMessageIdPresent: Number.isSafeInteger(firstDelivery.providerMessageId) }] });

    // Verify session context across separate Telegram turns. The follow-up
    // intentionally omits the nonce; only the preceding conversation contains it.
    const followupStartedAt = Date.now();
    const followupInput = await send('Repeat the exact token from my immediately previous message. Return only that token.');
    assert.equal(followupInput.ok, true, 'production_canary_followup_rejected');
    await checkpoint('followup_turn_accepted', { turns: [safeTaskSummary(firstTask, { matchedPriorNonce: true }),
      { accepted: true, pendingCount: Number.isSafeInteger(followupInput.collector?.pendingCount)
        ? followupInput.collector.pendingCount : null }] });
    assert.equal(followupInput.collector?.pendingCount, 1, 'production_canary_followup_not_buffered');
    assert.equal(followupInput.collector?.busy, false, 'production_canary_followup_lane_busy');
    const followupBarrier = controlPlaneBarrierCounts(followupInput.collector);
    assert.equal(followupBarrier.busyRequestCount, 0, 'production_canary_followup_busy_request_present');
    assert.equal(followupBarrier.unresolvedLaunchCount, 0, 'production_canary_followup_unresolved_launch_present');
    const followupLaunch = await pressCurrentLaunchButton();
    assert.equal(followupLaunch.ok, true, 'production_canary_followup_launch_failed');
    await checkpoint('followup_launch_callback', { turns: [
      safeTaskSummary(firstTask, { matchedPriorNonce: true }),
      { accepted: true, launch: summarizeLaunch(followupLaunch) },
    ] });
    assert(launchWasDispatched(followupLaunch, followupInput.collector), 'production_canary_followup_launch_not_dispatched');
    const followupObserved = await waitForTask(new Set([...baselineIds, firstTask.userTaskId]), followupStartedAt, nonce);
    task = followupObserved.task;
    await checkpoint('followup_turn_terminal', { turns: [safeTaskSummary(firstTask, { matchedPriorNonce: true }),
      safeTaskSummary(task, { matchedPriorNonce: task.answerMatchesChallenge === true })] });
    assert.equal(task.status, 'done', 'production_canary_followup_task_not_done');
    assert.equal(task.resultPresent, true, 'production_canary_followup_result_not_persisted');
    assert.equal(task.answerPresent, true, 'production_canary_followup_answer_not_persisted');
    assert.equal(task.answerMatchesChallenge, true, 'production_canary_followup_lost_prior_context');
    assert.equal(task.runs?.length, 1, 'production_canary_followup_run_count_mismatch');
    assert.equal(task.runs[0].status, 'success', 'production_canary_followup_runner_not_successful');
    assert.equal(task.runs[0].hasSessionId, true, 'production_canary_followup_session_not_persisted');
    assert.equal(task.runs[0].hasStartedAt, true, 'production_canary_followup_run_start_not_persisted');
    assert.equal(task.runs[0].hasFinishedAt, true, 'production_canary_followup_run_finish_not_persisted');
    assert((task.historyTypes ?? []).includes('run_finished'), 'production_canary_followup_finish_event_not_persisted');
    assert(followupObserved.buffer?.pendingCount === 0, 'production_canary_followup_buffer_not_drained');

    const followupDelivery = await waitForDelivery(task.userTaskId, chatId);
    await checkpoint('followup_turn_delivered', { turns: [
      { ...safeTaskSummary(firstTask, { matchedPriorNonce: true }), deliveryStatus: firstDelivery.status,
        providerMessageIdPresent: Number.isSafeInteger(firstDelivery.providerMessageId) },
      { ...safeTaskSummary(task, { matchedPriorNonce: true }), deliveryStatus: followupDelivery.status,
        providerMessageIdPresent: Number.isSafeInteger(followupDelivery.providerMessageId) },
    ] });
    const report = { ok: true, scenario: 'production-telegram-two-turn-session-context-and-delivery',
      profileId: PROFILE_ID, turns: [
        { taskId: firstTask.userTaskId, taskStatus: firstTask.status, runStatus: firstTask.runs[0].status,
          sessionPersisted: firstTask.runs[0].hasSessionId, resultPersisted: firstTask.resultPresent,
          answerMatchedNonce: true, telegramDeliveryStatus: firstDelivery.status },
        { taskId: task.userTaskId, taskStatus: task.status, runStatus: task.runs[0].status,
          sessionPersisted: task.runs[0].hasSessionId, resultPersisted: task.resultPresent,
          answerRecoveredPriorNonce: true, telegramDeliveryStatus: followupDelivery.status },
      ], telegramProviderMessageIdPresent: true, answerTextLogged: false };
    await checkpoint('complete', { ...report, ok: true });
    console.log(JSON.stringify(report));
  } finally {
    await cleanupIfTerminalAndIdle(username);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(async error => {
  // Assertions include a multiline expected/actual diff. Keep only a safe
  // first-line slug so failure evidence stays useful without ever emitting
  // transcripts, user input, answers, or credentials.
  const firstLine = error instanceof Error ? error.message.split(/\r?\n/, 1)[0] : '';
  const reason = /^[a-z0-9][a-z0-9_:.-]{0,159}$/i.test(firstLine)
    ? firstLine.toLowerCase() : 'production_canary_failed';
  await checkpoint(canaryProgress.phase, { ok: false, failureReasonCode: reason }).catch(() => {});
  console.error(JSON.stringify({ lane: TARGET, ok: false,
    reasonCode: reason }));
  process.exitCode = 1;
});
