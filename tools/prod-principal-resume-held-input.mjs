#!/usr/bin/env node
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { intakeIsIdle, summarizeIntakeState } from './e2e-oracle.mjs';

const worker = 'https://trained-assist-tg-sandbox3.skillset-apply.workers.dev';
const cp = 'https://trained-assist-cp-production.skillset-apply.workers.dev';
const profileId = 'production-e2e-telegram-v1';
const target = 'prod-principal';
const retryRoute = process.env.PRODUCTION_E2E_RETRY_ROUTE === 'true';
const RUN_FINISHED_EVENT = 'run_finished';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name.toLowerCase()}_required`);
  return value;
}

const operatorToken = required('TG_SANDBOX3_OPERATOR_TOKEN');
const signature = required('PRODUCTION_E2E_SIGNATURE');
const chatId = Number(required('TG_SANDBOX_E2E_CHAT_ID'));
const userId = Number(required('TG_SANDBOX_E2E_USER_ID'));
assert.equal(chatId, 1714048, 'prod_principal_chat_mismatch');
assert.equal(userId, 1714048, 'prod_principal_user_mismatch');

async function workerRequest(path, body) {
  const response = await fetch(`${worker}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${operatorToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`worker_${response.status}_${safeCode(payload.error)}`);
  return payload;
}

function safeCode(value) {
  return typeof value === 'string' && /^[a-z0-9_-]{1,80}$/i.test(value) ? value.toLowerCase() : 'failed';
}

async function cpStatus(taskId) {
  const response = await fetch(`${cp}/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-principal': profileId, 'x-principal-sig': signature },
    body: JSON.stringify({ taskId }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`control_plane_status_${response.status}`);
  return response.json();
}

function safeStatus(status) {
  const task = status.taskStore ?? {};
  const engine = status.engine && typeof status.engine === 'object' ? status.engine : {};
  const engineError = String(engine.error ?? '').toLowerCase();
  return {
    taskStatus: typeof task.status === 'string' ? task.status : null,
    stage: typeof task.stage === 'string' ? task.stage : null,
    workflowErrorCode: /not found|no such instance/.test(engineError)
      ? 'workflow_instance_missing' : null,
    workflowStatus: typeof engine.status === 'string' && /^[a-z_-]{1,40}$/i.test(engine.status)
      ? engine.status.toLowerCase() : null,
    runCount: Array.isArray(status.runs) ? status.runs.length : 0,
    runs: (status.runs ?? []).map(run => ({ status: run.status,
      hasSessionId: typeof run.session_id === 'string' && !!run.session_id,
      hasStartedAt: Number.isSafeInteger(run.started_at), hasFinishedAt: Number.isSafeInteger(run.finished_at) })),
  };
}

async function main() {
  let evidence = await workerRequest('/operator/test-evidence');
  assert.equal(evidence.profileId, profileId, 'prod_principal_profile_mismatch');
  const activeTasks = (evidence.tasks ?? []).filter(task => !['done', 'failed', 'cancelled'].includes(task.status));
  assert.equal(activeTasks.length, 1, 'prod_principal_expected_one_active_task');
  const task = activeTasks[0];
  assert.equal(task.status, 'active', 'prod_principal_task_not_active');
  assert.equal(task.runs?.length, 0, 'prod_principal_task_already_has_run');
  if (retryRoute) {
    assert.equal(task.routingOutcome?.known, true, 'prod_principal_prior_route_not_confirmed');
    assert.equal(task.routingOutcome?.continuationRequested, false, 'prod_principal_route_already_requested_continuation');
    assert.equal(task.routingOutcome?.continuationIssued, false, 'prod_principal_route_already_issued_continuation');
    assert([0, 1].includes(task.routingRetryCount), 'prod_principal_route_retry_state_invalid');
  }
  assert.equal(evidence.buffer?.pendingCount, 0, 'prod_principal_unexpected_pending_input');
  assert.equal(evidence.buffer?.busy, true, 'prod_principal_intake_not_waiting');
  assert.equal(evidence.buffer?.busyRequestCount, 1, 'prod_principal_admission_scope_ambiguous');

  let status = await cpStatus(task.userTaskId);
  assert.equal(status.taskStore?.id, task.userTaskId, 'prod_principal_cp_task_mismatch');
  assert.equal(status.taskStore?.status, 'active', 'prod_principal_cp_task_not_active');
  assert.equal(status.taskStore?.stage, 'queued', 'prod_principal_cp_stage_changed');
  assert.equal(status.runs?.length, 0, 'prod_principal_cp_run_already_exists');
  const challenge = /PROD-PRINCIPAL-[A-F0-9]{16}/.exec(JSON.stringify(status.taskStore))?.[0];
  assert(challenge, 'prod_principal_challenge_not_found');

  assert.equal(safeStatus(status).workflowErrorCode, 'workflow_instance_missing', 'prod_principal_workflow_instance_not_missing');
  assert.equal(typeof task.requestId, 'string', 'prod_principal_request_id_missing');
  // Wake the already-saved Intake DO alarm. In retry mode, the operator endpoint
  // also requires the exact pinned acceptance, zero CP runs, no prior continuation,
  // and a one-time retry budget before clearing the stale route receipt.
  const wake = await workerRequest('/operator/test-wake-pending-task', {
    target, taskId: task.userTaskId, requestId: task.requestId, ...(retryRoute ? { retryRoute: true } : {}),
  });
  assert.equal(wake.ok, true, 'prod_principal_pending_task_wake_failed');
  const expectedAction = retryRoute ? 'wake_saved_acceptance_route_retry' : 'wake_saved_acceptance_reconciliation';
  assert.equal(wake.action, expectedAction, 'prod_principal_pending_task_wake_action_mismatch');
  if (retryRoute) assert.equal(wake.routingRetryCount, 1, 'prod_principal_route_retry_not_committed');
  const wakeOutcome = retryRoute ? 'route_retry_scheduled'
    : wake.action === expectedAction ? 'scheduled' : 'unknown';
  assert.equal(wakeOutcome, retryRoute ? 'route_retry_scheduled' : 'scheduled', 'prod_principal_wake_not_scheduled');

  const deadline = Date.now() + 8 * 60_000;
  let taskEvidence;
  let cpView;
  while (Date.now() < deadline) {
    evidence = await workerRequest(`/operator/test-evidence?challenge=${encodeURIComponent(challenge)}`);
    taskEvidence = (evidence.tasks ?? []).find(candidate => candidate.userTaskId === task.userTaskId);
    cpView = await cpStatus(task.userTaskId);
    if (['done', 'failed', 'cancelled'].includes(taskEvidence?.status)) break;
    await new Promise(resolve => setTimeout(resolve, 4_000));
  }

  const terminal = ['done', 'failed', 'cancelled'].includes(taskEvidence?.status);
  const bufferState = summarizeIntakeState(evidence.buffer);
  const report = {
    ok: false,
    scenario: 'resume-existing-pinned-production-e2e-task',
    profileId,
    taskId: task.userTaskId,
    wakeOutcome,
    alarmScheduledAt: Number.isSafeInteger(wake.scheduledAt) ? wake.scheduledAt : null,
    task: taskEvidence ? {
      status: taskEvidence.status,
      routingRetryCount: taskEvidence.routingRetryCount,
      routingOutcome: taskEvidence.routingOutcome ? {
        known: taskEvidence.routingOutcome.known === true,
        degraded: taskEvidence.routingOutcome.degraded === true,
        routeReasonCode: taskEvidence.routingOutcome.routeReasonCode ?? null,
        continuationRequested: taskEvidence.routingOutcome.continuationRequested === true,
        continuationIssued: taskEvidence.routingOutcome.continuationIssued === true,
        continuationRefusal: taskEvidence.routingOutcome.continuationRefusal ?? null,
      } : null,
      reconciliationFailure: taskEvidence.reconciliationFailure ?? null,
      resultPersisted: taskEvidence.resultPresent === true,
      answerPersisted: taskEvidence.answerPresent === true,
      answerMatchedChallenge: taskEvidence.answerMatchesChallenge === true,
      eventTypes: taskEvidence.historyTypes ?? [],
      runFinishedEventPersisted: (taskEvidence.historyTypes ?? []).includes(RUN_FINISHED_EVENT),
    } : null,
    cp: cpView ? safeStatus(cpView) : null,
    telegramDeliveryStatus: null,
    telegramProviderMessageIdPresent: false,
    buffer: evidence.buffer ? {
      pendingCount: bufferState.pendingCount,
      busy: bufferState.busy,
      busyRequestCount: bufferState.busyRequestCount,
      alarmAt: bufferState.alarmAt,
    } : null,
    answerTextLogged: false,
    promptTextLogged: false,
  };

  if (terminal && taskEvidence.status === 'done') {
    assert.equal(taskEvidence.resultPresent, true, 'prod_principal_result_not_persisted');
    assert.equal(taskEvidence.answerPresent, true, 'prod_principal_answer_not_persisted');
    assert.equal(taskEvidence.answerMatchesChallenge, true, 'prod_principal_answer_mismatch');
    assert.equal(taskEvidence.runs?.length, 1, 'prod_principal_run_count_mismatch');
    assert.equal(taskEvidence.runs[0].status, 'success', 'prod_principal_runner_not_successful');
    assert.equal(taskEvidence.runs[0].hasSessionId, true, 'prod_principal_session_not_persisted');
    assert.equal(taskEvidence.runs[0].hasStartedAt, true, 'prod_principal_run_start_not_persisted');
    assert.equal(taskEvidence.runs[0].hasFinishedAt, true, 'prod_principal_run_finish_not_persisted');
    // A7: run_finished event presence is diagnostic only, never a verdict gate.
    const delivery = await workerRequest(`/operator/test-delivery/${encodeURIComponent(task.userTaskId)}`);
    assert.equal(delivery.terminal?.status, 'sent', 'prod_principal_delivery_not_sent');
    assert.equal(String(delivery.terminal.chatId), String(chatId), 'prod_principal_delivery_chat_mismatch');
    assert(Number.isSafeInteger(delivery.terminal.providerMessageId) && delivery.terminal.providerMessageId > 0,
      'prod_principal_provider_message_id_missing');
    report.ok = true;
    report.telegramDeliveryStatus = delivery.terminal.status;
    report.telegramProviderMessageIdPresent = true;
  }

  if (terminal && intakeIsIdle(evidence.buffer)) {
    const cleanup = await workerRequest('/operator/test-cleanup', {
      target, confirm: 'CLEAN_PINNED_TEST_CHAT',
    });
    if (cleanup.ok !== true || cleanup.loginSessionDeleted !== true) throw new Error('prod_principal_scoped_cleanup_failed');
    report.bufferCleaned = true;
  } else {
    report.bufferCleaned = false;
  }

  await writeFile('prod-principal-telegram-evidence.json', `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(report));
  if (!terminal) throw new Error('prod_principal_task_not_terminal_after_resume');
  if (taskEvidence.status !== 'done') throw new Error(`production_e2e_task_${safeCode(taskEvidence.status)}`);
  if (!report.ok) throw new Error('prod_principal_resume_checks_failed');
  if (!report.bufferCleaned) throw new Error('prod_principal_buffer_not_clean');
}

main().catch(error => {
  const firstLine = error instanceof Error ? error.message.split(/\r?\n/, 1)[0] : '';
  const reasonCode = /^[a-z0-9][a-z0-9_:.-]{0,159}$/i.test(firstLine)
    ? firstLine.toLowerCase() : 'prod_principal_resume_failed';
  console.error(JSON.stringify({ ok: false, reasonCode, answerTextLogged: false, promptTextLogged: false }));
  process.exitCode = 1;
});
