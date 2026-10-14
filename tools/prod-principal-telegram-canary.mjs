#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { cleanupReadiness, controlPlaneBarrierCounts, intakeIsIdle, launchWasDispatched,
  summarizeIntakeState, summarizeLaunch } from './e2e-oracle.mjs';

export { cleanupReadiness, intakeIsIdle, launchWasDispatched, summarizeIntakeState,
  summarizeLaunch };

const WORKER = 'https://trained-assist-tg-sandbox3.skillset-apply.workers.dev';
// E6: this canary proves production-principle of the CP/Runner (real production
// CP profile -> real production Runner on the France VM), NOT the real production
// bot path. It is pinned to the shared test bot ptichka_status_bot in the private
// operator chat 1714048. The lane label and bot assertion make that honesty
// machine-readable so a run that ever targets the real production bot
// (super_personal_assistant_bot) fails loudly instead of relabelling a test lane.
const LANE = 'prod-principal';
const EXPECTED_BOT_USERNAME = 'ptichka_status_bot';
const PROFILE_ID = 'production-e2e-telegram-v1';
const TARGET = 'prod-principal';
const RUN_FINISHED_EVENT = 'run_finished';
let canaryProgress = {
  ok: false,
  scenario: 'prod-principal-two-turn-session-context-and-delivery',
  profileId: PROFILE_ID,
  lane: LANE,
  targetWorkerUrl: WORKER,
  buildSha: process.env.GITHUB_SHA ?? null,
  phase: 'starting',
  turns: [],
  answerTextLogged: false,
  promptTextLogged: false,
};

async function checkpoint(phase, patch = {}) {
  canaryProgress = { ...canaryProgress, ...patch, phase };
  await writeFile('prod-principal-telegram-evidence.json', `${JSON.stringify(canaryProgress, null, 2)}\n`, { mode: 0o600 });
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
    // A7: diagnostic only — event/history presence never gates the verdict.
    runFinishedEventPersisted: (task?.historyTypes ?? []).includes(RUN_FINISHED_EVENT),
  };
}

// A7: the acceptance verdict is a pure function of durable task-store state.
// Recorded events (eventTypes, runFinishedEventPersisted) are diagnostics and
// are deliberately not inputs here, so a canary run with logging disabled
// produces the same PASS/FAIL as a run with full event history.
export function durableTurnVerdict(turn = {}) {
  return turn.taskStatus === 'done' && turn.runCount === 1 && turn.runStatus === 'success' &&
    turn.sessionPersisted === true && turn.resultPersisted === true && turn.answerPersisted === true &&
    turn.answerMatchedPriorNonce === true && turn.startTimePersisted === true && turn.finishTimePersisted === true;
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_required`);
  return value;
}

function identity() {
  const chatId = Number(required('TG_SANDBOX_E2E_CHAT_ID'));
  const userId = Number(required('TG_SANDBOX_E2E_USER_ID'));
  assert.equal(chatId, 1714048, 'prod_principal_canary_chat_mismatch');
  assert.equal(userId, 1714048, 'prod_principal_canary_user_mismatch');
  return { chatId, userId };
}

// Pure lane-identity verdict: the canary is honest only when the Worker it talks
// to is the pinned test bot. Any other bot — including the real production bots —
// is a mismatch, so the canary can never silently run the prod bot under a
// "production" label.
export function verifyLaneIdentity(health = {}) {
  const bot = typeof health?.bot === 'string'
    ? health.bot.trim().replace(/^@/, '').toLowerCase() : null;
  return { lane: LANE, botUsername: bot, expectedBotUsername: EXPECTED_BOT_USERNAME,
    botMatches: bot === EXPECTED_BOT_USERNAME };
}

async function verifyLiveLaneIdentity() {
  return waitForLaneIdentity(async () => {
    const response = await fetch(`${WORKER}/health`, { cache: 'no-store', headers: { 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error('health_not_ready');
    return response.json().catch(() => ({}));
  }, { expectedBuildSha: process.env.GITHUB_SHA });
}

export async function waitForLaneIdentity(readHealth, { expectedBuildSha, timeoutMs = 120_000,
  intervalMs = 2_000, now = () => Date.now(), sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) } = {}) {
  const deadline = now() + timeoutMs;
  let health = {};
  while (now() <= deadline) {
    try { health = await readHealth(); } catch { health = {}; }
    const identity = verifyLaneIdentity(health);
    const revisionMatches = typeof expectedBuildSha === 'string' && /^[a-f0-9]{40}$/.test(expectedBuildSha)
      && health?.buildSha === expectedBuildSha;
    if (identity.botMatches && revisionMatches) return { ...identity, buildSha: health.buildSha };
    if (now() >= deadline) break;
    await sleep(Math.min(intervalMs, deadline - now()));
  }
  const identity = verifyLaneIdentity(health);
  if (!identity.botMatches) {
    throw new Error(`prod_principal_bot_mismatch_expected_${EXPECTED_BOT_USERNAME}_got_${identity.botUsername ?? 'missing'}`);
  }
  throw new Error('prod_principal_worker_revision_not_propagated');
}

async function workerRequest(path, body) {
  const method = body === undefined ? 'GET' : 'POST';
  const retryDeadline = Date.now() + 60_000;
  while (true) {
    const response = await fetch(`${WORKER}${path}`, { method, cache: 'no-store',
      headers: { authorization: `Bearer ${required('TG_SANDBOX3_OPERATOR_TOKEN')}`, 'cache-control': 'no-cache',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000) });
    const payload = await response.json().catch(() => ({}));
    if (response.ok) return payload;
    if (path === '/operator/test-update' && shouldRetryTestUpdate(response.status, payload.error, body)
        && Date.now() < retryDeadline) {
      await new Promise(resolve => setTimeout(resolve, 1_000));
      continue;
    }
    // Keep production canary failures actionable without logging the captured
    // transcript, which can contain temporary credentials or user input.
    const safeCode = typeof payload.code === 'string' && /^[a-z0-9_-]{1,80}$/i.test(payload.code)
      ? payload.code.toLowerCase() : null;
    const safeError = typeof payload.error === 'string' && /^[a-z0-9_-]{1,80}$/i.test(payload.error)
      ? payload.error.toLowerCase() : 'failed';
    const innerStatus = Number.isSafeInteger(payload.status) ? `webhook_${payload.status}` : null;
    const suffix = [innerStatus, safeCode].filter(Boolean).join('_');
    if (path === '/operator/test-update') await checkpoint('test_update_rejected', {
      failedPhase: canaryProgress.phase, failureReasonCode: safeError,
      requestShape: summarizeTestUpdateRequest(body),
    });
    throw new Error(`worker_${path.replaceAll('/', '_').toLowerCase()}_${response.status}_${safeError}${suffix ? `_${suffix}` : ''}`);
  }
}

export function shouldRetryTestUpdate(status, error, body) {
  if (status !== 409) return false;
  if (error === 'sandbox_test_api_not_ready') return true;
  return body?.type === 'callback' && ['no_current_button_message', 'no_current_button_revision'].includes(error);
}

export function summarizeTestUpdateRequest(body = {}) {
  const text = typeof body.text === 'string' ? body.text : '';
  const command = /^\/(adduser|login)(?:\s|$)/i.exec(text)?.[1]?.toLowerCase() ?? null;
  return {
    requestType: ['message', 'callback'].includes(body.type) ? body.type : 'other',
    delivery: ['capture', 'telegram'].includes(body.delivery) ? body.delivery : 'other',
    targetMatches: body.target === TARGET,
    chatMatchesPinnedIdentity: body.chatId === 1714048,
    userMatchesPinnedIdentity: body.userId === 1714048,
    updateIdIsSafeInteger: Number.isSafeInteger(body.updateId) && body.updateId >= 0,
    textLengthBucket: text.length === 0 ? 'empty' : text.length <= 256 ? 'short' : text.length <= 2048 ? 'medium' : 'long',
    command,
    callbackDataRecognized: body.callbackData === 'auto',
  };
}

export function summarizeCallbackResponse(payload = {}) {
  const transcript = Array.isArray(payload.transcript) ? payload.transcript : [];
  const outcomeCodes = transcript.map(entry => {
    const text = typeof entry?.text === 'string' ? entry.text : '';
    if (/кнопка.*устарела/i.test(text)) return 'callback_stale';
    if (text.includes('не удалось подтвердить запуск')) return 'launch_not_confirmed';
    if (text.includes('Передаю собранный ввод') || text.includes('Передаю задачу агенту')) return 'launch_handoff_started';
    if (text.includes('Передача этого ввода уже обрабатывается')) return 'callback_in_flight';
    if (text.includes('Не удалось подтвердить запуск')) return 'launch_not_confirmed';
    return 'other_message';
  });
  const admission = payload.admission && typeof payload.admission === 'object' ? payload.admission : {};
  return {
    webhookOk: admission.ok === true,
    callbackUnsupported: admission.unsupported === true,
    authenticated: admission.authenticated === true,
    serviceCommand: typeof admission.serviceCommand === 'string' ? admission.serviceCommand : null,
    transcriptEntryCount: transcript.length,
    callbackOwnedBeforeDispatch: payload.callbackOwnedBeforeDispatch === true,
    transcriptKinds: transcript.map(entry => typeof entry?.kind === 'string' && /^[a-zA-Z]{1,40}$/.test(entry.kind)
      ? entry.kind : 'other'),
    outcomeCodes,
  };
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
  // Keep one updateId across retries. Each retryable response is produced
  // before the synthetic webhook is dispatched, so this remains idempotent.
  return workerRequest('/operator/test-update', { target: TARGET, type: 'callback', chatId, userId,
    delivery: 'telegram', callbackData: 'auto', updateId: Date.now() + Math.floor(Math.random() * 1000) });
}

export async function waitForLiveLane(readEvidence, { expectedBuildSha, timeoutMs = 180_000, intervalMs = 2_000,
  now = () => Date.now(), sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) } = {}) {
  const deadline = now() + timeoutMs;
  let lastReadiness = null;
  let workerProfileObserved = false;
  let intakeProfileObserved = false;
  let expectedRevisionObserved = expectedBuildSha === undefined;
  while (now() < deadline) {
    const evidence = await readEvidence();
    workerProfileObserved ||= evidence.workerProfileId === PROFILE_ID;
    intakeProfileObserved ||= evidence.profileId === PROFILE_ID;
    expectedRevisionObserved ||= evidence.buildSha === expectedBuildSha;
    lastReadiness = evidence.readiness ?? {};
    if (liveLaneIsReady(evidence) && evidence.workerProfileId === PROFILE_ID && evidence.profileId === PROFILE_ID
      && (expectedBuildSha === undefined || evidence.buildSha === expectedBuildSha)) return evidence;
    // The isolated live config is deployed immediately after a paused version.
    // Some Cloudflare edges can briefly serve the prior Worker version, whose
    // profile identity differs. Poll until the intended profile and live
    // readiness are both visible; do not send messages to that old lane.
    await sleep(Math.min(intervalMs, deadline - now()));
  }
  if (!workerProfileObserved) throw new Error('prod_principal_canary_worker_profile_not_propagated');
  if (!expectedRevisionObserved) throw new Error('prod_principal_canary_worker_revision_not_propagated');
  if (!intakeProfileObserved) throw new Error('prod_principal_canary_intake_profile_not_propagated');
  throw new Error(`prod_principal_canary_lane_not_ready_test_api_${lastReadiness?.testApiEnabled ? 'on' : 'off'}_ingress_paused_${lastReadiness?.ingressPaused ? 'yes' : 'no'}_delivery_paused_${lastReadiness?.deliveryPaused ? 'yes' : 'no'}`);
}

async function waitForTask(baselineIds, startedAt, challenge) {
  const deadline = Date.now() + 8 * 60_000;
  let task = null;
  while (Date.now() < deadline) {
    const evidence = await workerRequest(`/operator/test-evidence?challenge=${encodeURIComponent(challenge)}`);
    assert.equal(evidence.profileId, PROFILE_ID, 'prod_principal_canary_profile_mismatch');
    const candidates = (evidence.tasks ?? []).filter(candidate => !baselineIds.has(candidate.userTaskId)
      && Number(candidate.acceptedAt) >= startedAt);
    // Return any terminal task so the caller can report an answer mismatch
    // immediately instead of waiting eight minutes for a matching answer.
    task = candidates.find(candidate => ['done', 'failed', 'cancelled'].includes(candidate.status)) ?? null;
    if (task && ['done', 'failed', 'cancelled'].includes(task.status)) return { task, buffer: evidence.buffer };
    await new Promise(resolve => setTimeout(resolve, 4_000));
  }
  throw new Error(`prod_principal_canary_task_timeout_${task?.status ?? 'not_admitted'}`);
}

async function waitForDelivery(taskId, chatId) {
  const deadline = Date.now() + 3 * 60_000;
  let result;
  while (Date.now() < deadline) {
    result = await workerRequest(`/operator/test-delivery/${encodeURIComponent(taskId)}`);
    if (result.terminal?.status === 'sent') {
      assert.equal(String(result.terminal.chatId), String(chatId), 'prod_principal_canary_answer_chat_mismatch');
      assert(Number.isSafeInteger(result.terminal.providerMessageId) && result.terminal.providerMessageId > 0,
        'prod_principal_canary_provider_message_id_missing');
      return result.terminal;
    }
    if (['dead', 'unknown'].includes(result.terminal?.status)) throw new Error(`prod_principal_canary_delivery_${result.terminal.status}`);
    await new Promise(resolve => setTimeout(resolve, 3_000));
  }
  throw new Error(`prod_principal_canary_delivery_timeout_${result?.terminal?.status ?? 'not_queued'}`);
}

export function liveLaneIsReady(evidence) {
  return evidence?.profileId === PROFILE_ID && evidence?.readiness?.testApiEnabled === true &&
    evidence?.readiness?.ingressPaused === false && evidence?.readiness?.deliveryPaused === false;
}

export async function waitForCleanupReadiness(readEvidence, {
  timeoutMs = 60_000,
  intervalMs = 2_000,
  now = () => Date.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  onPending = async () => {},
} = {}) {
  const deadline = now() + timeoutMs;
  let evidence = null;
  let readiness = cleanupReadiness();
  while (now() < deadline) {
    evidence = await readEvidence();
    readiness = cleanupReadiness(evidence);
    if (readiness.ready) return { ...readiness, evidence };
    await onPending(readiness);
    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())));
  }
  return { ...readiness, evidence };
}

async function waitForIntakeIdle() {
  const deadline = Date.now() + 90_000;
  let lastState = null;
  let lastCheckpointAt = 0;
  while (Date.now() < deadline) {
    const evidence = await workerRequest('/operator/test-evidence');
    assert.equal(evidence.profileId, PROFILE_ID, 'prod_principal_canary_profile_mismatch');
    lastState = summarizeIntakeState(evidence.buffer);
    if (intakeIsIdle(evidence.buffer)) return lastState;
    if (Date.now() - lastCheckpointAt >= 10_000) {
      await checkpoint('waiting_for_first_turn_intake_idle', { followupReadiness: lastState });
      lastCheckpointAt = Date.now();
    }
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
  await checkpoint('first_turn_intake_idle_timeout', { followupReadiness: lastState });
  throw new Error('prod_principal_canary_first_turn_intake_idle_timeout');
}

async function cleanupIfTerminalAndIdle(username) {
  let lastCheckpointAt = 0;
  const readiness = await waitForCleanupReadiness(async () => {
    const evidence = await workerRequest('/operator/test-evidence');
    assert.equal(evidence.profileId, PROFILE_ID, 'prod_principal_canary_cleanup_profile_mismatch');
    return evidence;
  }, { onPending: async state => {
    if (Date.now() - lastCheckpointAt < 10_000) return;
    await checkpoint('waiting_for_cleanup_terminal_and_idle', { cleanup: {
      ok: false, deferred: false, tasksTerminal: state.tasksTerminal, intakeIdle: state.intakeIdle,
    } });
    lastCheckpointAt = Date.now();
  } });
  if (!readiness.ready) {
    await checkpoint('cleanup_deferred_for_active_or_unknown_task', { cleanup: {
      ok: false, deferred: true, tasksTerminal: readiness.tasksTerminal, intakeIdle: readiness.intakeIdle,
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
    throw new Error('prod_principal_canary_cleanup_incomplete');
  }
  return true;
}

async function main() {
  if (process.env.TG_SANDBOX_TARGET !== TARGET) throw new Error('prod_principal_canary_target_required');
  const { chatId } = identity();
  const laneIdentity = await verifyLiveLaneIdentity();
  const before = await waitForLiveLane(() => workerRequest('/operator/test-evidence'), {
    expectedBuildSha: process.env.GITHUB_SHA,
  });
  if (before.buffer?.busy || before.buffer?.launching ||
      before.buffer?.unresolvedLaunchCount || before.buffer?.busyRequestCount) {
    throw new Error('prod_principal_canary_intake_not_idle');
  }
  if ((before.tasks ?? []).some(task => !['done', 'failed', 'cancelled'].includes(task.status))) {
    throw new Error('prod_principal_canary_previous_task_not_terminal');
  }
  await checkpoint('lane_ready', { priorTaskCount: (before.tasks ?? []).length, intakeIdle: true,
    botUsername: laneIdentity.botUsername });
  const baselineIds = new Set((before.tasks ?? []).map(task => task.userTaskId));
  // A prior interrupted canary may leave only an unlaunched draft. The pinned
  // test cleanup endpoint clears this exact chat's Intake/session state and
  // refuses if the DO still has an active dispatch; CP history is untouched.
  const clean = await workerRequest('/operator/test-cleanup', {
    target: TARGET, confirm: 'CLEAN_PINNED_TEST_CHAT',
  });
  assert.equal(clean.ok, true, 'prod_principal_canary_initial_cleanup_failed');
  const cleaned = await workerRequest('/operator/test-evidence');
  assert.equal(cleaned.buffer?.pendingCount, 0, 'prod_principal_canary_buffer_not_clean');
  await checkpoint('initial_cleanup_complete', { intakeIdle: true });

  const username = `prod_principal_${randomBytes(6).toString('hex')}`;
  let task = null;
  try {
    await checkpoint('creating_test_profile');
    const created = await capture(`/adduser ${username} Production E2E`, { admin: true });
    assert.equal(created.ok, true, 'prod_principal_canary_profile_create_failed');
    const text = (created.transcript ?? []).map(item => String(item.text ?? '')).join('\n');
    const password = /Пароль:\s*<code>([^<]+)<\/code>/i.exec(text)?.[1];
    assert(password, 'prod_principal_canary_profile_password_missing');

    await checkpoint('authenticating_test_profile');
    const login = await send(`/login ${username} ${password}`);
    assert.equal(login.admission?.authenticated, true, 'prod_principal_canary_login_failed');
    await checkpoint('test_profile_authenticated', { loginAuthenticated: true });

    const nonce = `PROD-PRINCIPAL-${randomBytes(8).toString('hex').toUpperCase()}`;
    const startedAt = Date.now();
    // Use a concrete user task so Communication routing cannot reasonably
    // classify an echo-only probe as the deterministic system-health quick answer.
    await checkpoint('submitting_first_turn');
    const question = await send(`Create a concise three-step checklist for organizing a small community event. Include this unique marker exactly once: ${nonce}`);
    assert.equal(question.ok, true, 'prod_principal_canary_question_rejected');
    await checkpoint('first_turn_accepted', { turns: [{ accepted: true,
      pendingCount: Number.isSafeInteger(question.collector?.pendingCount) ? question.collector.pendingCount : null }] });
    assert.equal(question.collector?.pendingCount, 1, 'prod_principal_canary_input_not_buffered');

    const { userId } = identity();
    await checkpoint('launching_first_turn');
    const launched = await pressCurrentLaunchButton();
    assert.equal(launched.ok, true, 'prod_principal_canary_launch_callback_failed');
    assert.equal(launched.callbackOwnedBeforeDispatch, true, 'prod_principal_canary_callback_not_currently_owned');
    const launchState = launched.collector ?? {};
    await checkpoint('first_turn_launch_callback', { turns: [{ accepted: true,
      launch: summarizeLaunch(launched), admissionCode: typeof launched.admission?.code === 'string'
        ? launched.admission.code : null, callbackAccepted: launched.admission?.ok === true,
      callbackResponse: summarizeCallbackResponse(launched) }] });
    if (launchState.pendingCount !== 0 && launchState.busy !== true &&
        !(launchState.launchingMessageIds ?? []).length &&
        !(Number(launchState.controlPlaneBarrier?.busyRequestCount) > 0) &&
        !(Number(launchState.controlPlaneBarrier?.unresolvedLaunchCount) > 0)) {
      throw new Error(`prod_principal_canary_launch_not_dispatched_pending_${launchState.pendingCount ?? 'unknown'}`);
    }

    const observed = await waitForTask(baselineIds, startedAt, nonce);
    task = observed.task;
    const firstTurn = safeTaskSummary(task, { matchedPriorNonce: task.answerMatchesChallenge === true });
    assert(durableTurnVerdict(firstTurn), 'prod_principal_canary_terminal_state_not_durable');
    await checkpoint('first_turn_terminal', { turns: [firstTurn] });
    assert.equal(task.status, 'done', 'prod_principal_canary_task_not_done');
    assert.equal(task.resultPresent, true, 'prod_principal_canary_result_not_persisted');
    assert.equal(task.answerPresent, true, 'prod_principal_canary_answer_not_persisted');
    assert.equal(task.answerMatchesChallenge, true, 'prod_principal_canary_answer_mismatch');
    assert.equal(task.runs?.length, 1, 'prod_principal_canary_run_count_mismatch');
    assert.equal(task.runs[0].status, 'success', 'prod_principal_canary_runner_not_successful');
    assert.equal(task.runs[0].hasSessionId, true, 'prod_principal_canary_session_not_persisted');
    assert.equal(task.runs[0].hasStartedAt, true, 'prod_principal_canary_run_start_not_persisted');
    assert.equal(task.runs[0].hasFinishedAt, true, 'prod_principal_canary_run_finish_not_persisted');
    assert(observed.buffer?.pendingCount === 0, 'prod_principal_canary_buffer_not_drained');

    const firstTask = task;
    const firstDelivery = await waitForDelivery(firstTask.userTaskId, chatId);
    const firstTurnSummary = { ...firstTurn, deliveryStatus: firstDelivery.status,
      providerMessageIdPresent: Number.isSafeInteger(firstDelivery.providerMessageId) };
    await checkpoint('first_turn_delivered', { turns: [firstTurnSummary] });
    const intakeAfterFirstTurn = await waitForIntakeIdle();
    await checkpoint('first_turn_delivery_and_intake_idle', { turns: [firstTurnSummary],
      followupReadiness: intakeAfterFirstTurn });

    // Verify session context across separate Telegram turns. The follow-up
    // intentionally omits the nonce; only the preceding conversation contains it.
    const followupStartedAt = Date.now();
    await checkpoint('submitting_followup_turn');
    const followupInput = await send('Repeat the exact token from my immediately previous message. Return only that token.');
    assert.equal(followupInput.ok, true, 'prod_principal_canary_followup_rejected');
    await checkpoint('followup_turn_accepted', { turns: [firstTurnSummary,
      { accepted: true, pendingCount: Number.isSafeInteger(followupInput.collector?.pendingCount)
        ? followupInput.collector.pendingCount : null }] });
    assert.equal(followupInput.collector?.pendingCount, 1, 'prod_principal_canary_followup_not_buffered');
    assert.equal(followupInput.collector?.busy, false, 'prod_principal_canary_followup_lane_busy');
    const followupBarrier = controlPlaneBarrierCounts(followupInput.collector);
    assert.equal(followupBarrier.busyRequestCount, 0, 'prod_principal_canary_followup_busy_request_present');
    assert.equal(followupBarrier.unresolvedLaunchCount, 0, 'prod_principal_canary_followup_unresolved_launch_present');
    await checkpoint('launching_followup_turn');
    const followupLaunch = await pressCurrentLaunchButton();
    assert.equal(followupLaunch.ok, true, 'prod_principal_canary_followup_launch_failed');
    await checkpoint('followup_launch_callback', { turns: [
      firstTurnSummary,
      { accepted: true, launch: summarizeLaunch(followupLaunch),
        callbackResponse: summarizeCallbackResponse(followupLaunch) },
    ] });
    assert(launchWasDispatched(followupLaunch, followupInput.collector), 'prod_principal_canary_followup_launch_not_dispatched');
    const followupObserved = await waitForTask(new Set([...baselineIds, firstTask.userTaskId]), followupStartedAt, nonce);
    task = followupObserved.task;
    const followupTurn = safeTaskSummary(task, { matchedPriorNonce: task.answerMatchesChallenge === true });
    assert(durableTurnVerdict(followupTurn), 'prod_principal_canary_followup_state_not_durable');
    await checkpoint('followup_turn_terminal', { turns: [firstTurnSummary, followupTurn] });
    assert.equal(task.status, 'done', 'prod_principal_canary_followup_task_not_done');
    assert.equal(task.resultPresent, true, 'prod_principal_canary_followup_result_not_persisted');
    assert.equal(task.answerPresent, true, 'prod_principal_canary_followup_answer_not_persisted');
    assert.equal(task.answerMatchesChallenge, true, 'prod_principal_canary_followup_lost_prior_context');
    assert.equal(task.runs?.length, 1, 'prod_principal_canary_followup_run_count_mismatch');
    assert.equal(task.runs[0].status, 'success', 'prod_principal_canary_followup_runner_not_successful');
    assert.equal(task.runs[0].hasSessionId, true, 'prod_principal_canary_followup_session_not_persisted');
    assert.equal(task.runs[0].hasStartedAt, true, 'prod_principal_canary_followup_run_start_not_persisted');
    assert.equal(task.runs[0].hasFinishedAt, true, 'prod_principal_canary_followup_run_finish_not_persisted');
    assert(followupObserved.buffer?.pendingCount === 0, 'prod_principal_canary_followup_buffer_not_drained');

    const followupDelivery = await waitForDelivery(task.userTaskId, chatId);
    await checkpoint('followup_turn_delivered', { turns: [
      firstTurnSummary,
      { ...followupTurn, deliveryStatus: followupDelivery.status,
        providerMessageIdPresent: Number.isSafeInteger(followupDelivery.providerMessageId) },
    ] });
    const report = { ok: true, scenario: 'prod-principal-two-turn-session-context-and-delivery',
      profileId: PROFILE_ID, lane: LANE, botUsername: laneIdentity.botUsername,
      targetWorkerUrl: WORKER, buildSha: process.env.GITHUB_SHA ?? null, turns: [
        { taskId: firstTask.userTaskId, taskStatus: firstTask.status, runStatus: firstTask.runs[0].status,
          sessionPersisted: firstTask.runs[0].hasSessionId, resultPersisted: firstTask.resultPresent,
          answerMatchedNonce: true, telegramDeliveryStatus: firstDelivery.status,
          runFinishedEventPersisted: firstTurn.runFinishedEventPersisted },
        { taskId: task.userTaskId, taskStatus: task.status, runStatus: task.runs[0].status,
          sessionPersisted: task.runs[0].hasSessionId, resultPersisted: task.resultPresent,
          answerRecoveredPriorNonce: true, telegramDeliveryStatus: followupDelivery.status,
          runFinishedEventPersisted: followupTurn.runFinishedEventPersisted },
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
    ? firstLine.toLowerCase() : 'prod_principal_canary_failed';
  await checkpoint(canaryProgress.phase, { ok: false, failureReasonCode: reason }).catch(() => {});
  console.error(JSON.stringify({ lane: TARGET, ok: false,
    reasonCode: reason }));
  process.exitCode = 1;
});
