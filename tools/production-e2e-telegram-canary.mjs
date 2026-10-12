#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const WORKER = 'https://trained-assist-tg-sandbox3.skillset-apply.workers.dev';
const PROFILE_ID = 'production-e2e-telegram-v1';
const TARGET = 'productionE2e';

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
      ? payload.code : null;
    const innerStatus = Number.isSafeInteger(payload.status) ? `webhook_${payload.status}` : null;
    const suffix = [innerStatus, safeCode].filter(Boolean).join('_');
    throw new Error(`worker_${path.replaceAll('/', '_')}_${response.status}_${payload.error ?? 'failed'}${suffix ? `_${suffix}` : ''}`);
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

async function waitForTask(baselineIds, startedAt, challenge) {
  const deadline = Date.now() + 8 * 60_000;
  let task = null;
  while (Date.now() < deadline) {
    const evidence = await workerRequest(`/operator/test-evidence?challenge=${encodeURIComponent(challenge)}`);
    assert.equal(evidence.profileId, PROFILE_ID, 'production_canary_profile_mismatch');
    const candidates = (evidence.tasks ?? []).filter(candidate => !baselineIds.has(candidate.userTaskId)
      && Number(candidate.acceptedAt) >= startedAt);
    task = candidates.find(candidate => candidate.status === 'done' && candidate.answerMatchesChallenge === true)
      ?? candidates.find(candidate => ['failed', 'cancelled'].includes(candidate.status)) ?? null;
    if (task && ['done', 'failed', 'cancelled'].includes(task.status)) return { task, buffer: evidence.buffer };
    await new Promise(resolve => setTimeout(resolve, 4_000));
  }
  throw new Error(`production_canary_task_timeout_${task?.status ?? 'not_admitted'}`);
}

async function waitForBufferIdle() {
  const deadline = Date.now() + 3 * 60_000;
  let evidence;
  while (Date.now() < deadline) {
    evidence = await workerRequest('/operator/test-evidence');
    const buffer = evidence.buffer ?? {};
    const active = buffer.busy || buffer.pendingCount || buffer.launching ||
      buffer.unresolvedLaunchCount || buffer.busyRequestCount;
    const nonterminal = (evidence.tasks ?? []).some(task => !['done', 'failed', 'cancelled'].includes(task.status));
    if (!active && !nonterminal) return evidence;
    await new Promise(resolve => setTimeout(resolve, 3_000));
  }
  throw new Error(`production_canary_buffer_did_not_drain_${evidence?.buffer?.busy ? 'busy' : 'pending'}`);
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

async function main() {
  if (process.env.TG_SANDBOX_TARGET !== TARGET) throw new Error('production_canary_target_required');
  const { chatId } = identity();
  const before = await workerRequest('/operator/test-evidence');
  assert.equal(before.profileId, PROFILE_ID, 'production_canary_profile_mismatch');
  if (before.readiness?.testApiEnabled !== true || before.readiness?.ingressPaused !== false ||
      before.readiness?.deliveryPaused !== false) {
    throw new Error(`production_canary_lane_not_ready_test_api_${before.readiness?.testApiEnabled ? 'on' : 'off'}_ingress_paused_${before.readiness?.ingressPaused ? 'yes' : 'no'}_delivery_paused_${before.readiness?.deliveryPaused ? 'yes' : 'no'}`);
  }
  if (before.buffer?.busy || before.buffer?.launching ||
      before.buffer?.unresolvedLaunchCount || before.buffer?.busyRequestCount) {
    throw new Error('production_canary_intake_not_idle');
  }
  if ((before.tasks ?? []).some(task => !['done', 'failed', 'cancelled'].includes(task.status))) {
    throw new Error('production_canary_previous_task_not_terminal');
  }
  const baselineIds = new Set((before.tasks ?? []).map(task => task.userTaskId));
  const clean = await workerRequest('/operator/test-cleanup', {
    target: TARGET, confirm: 'CLEAN_PINNED_TEST_CHAT',
  });
  assert.equal(clean.ok, true, 'production_canary_initial_cleanup_failed');
  const cleaned = await workerRequest('/operator/test-evidence');
  assert.equal(cleaned.buffer?.pendingCount, 0, 'production_canary_buffer_not_clean');

  const username = `production_e2e_${randomBytes(6).toString('hex')}`;
  let task = null;
  let taskTerminal = false;
  try {
    const created = await capture(`/adduser ${username} Production E2E`, { admin: true });
    assert.equal(created.ok, true, 'production_canary_profile_create_failed');
    const text = (created.transcript ?? []).map(item => String(item.text ?? '')).join('\n');
    const password = /Пароль:\s*<code>([^<]+)<\/code>/i.exec(text)?.[1];
    assert(password, 'production_canary_profile_password_missing');

    const login = await send(`/login ${username} ${password}`);
    assert.equal(login.admission?.authenticated, true, 'production_canary_login_failed');

    const nonce = `PROD-E2E-${randomBytes(8).toString('hex').toUpperCase()}`;
    const startedAt = Date.now();
    const question = await send(`Reply with exactly this token and nothing else: ${nonce}`);
    assert.equal(question.ok, true, 'production_canary_question_rejected');
    assert.equal(question.collector?.pendingCount, 1, 'production_canary_input_not_buffered');

    const { userId } = identity();
    const launched = await workerRequest('/operator/test-update', { target: TARGET, type: 'callback', chatId, userId,
      delivery: 'telegram', callbackData: 'auto', updateId: Date.now() + 1 });
    assert.equal(launched.ok, true, 'production_canary_launch_callback_failed');

    const observed = await waitForTask(baselineIds, startedAt, nonce);
    task = observed.task;
    taskTerminal = ['done', 'failed', 'cancelled'].includes(task.status);
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

    const delivery = await waitForDelivery(task.userTaskId, chatId);
    const report = { ok: true, scenario: 'sandbox-telegram-ingress-to-production-cp-runner-france-vm-and-telegram-delivery',
      taskId: task.userTaskId, profileId: PROFILE_ID, taskStatus: task.status,
      runStatus: task.runs[0].status, sessionPersisted: task.runs[0].hasSessionId,
      resultPersisted: task.resultPresent, answerMatchedNonce: true,
      resultEventTypes: task.historyTypes ?? [], telegramDeliveryStatus: delivery.status,
      telegramProviderMessageIdPresent: true, answerTextLogged: false };
    await writeFile('production-e2e-telegram-evidence.json', `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify(report));
  } finally {
    if (!task || taskTerminal) {
      await waitForBufferIdle();
      const cleanup = await workerRequest('/operator/test-cleanup', {
        target: TARGET, confirm: 'CLEAN_PINNED_TEST_CHAT', username,
      });
      if (cleanup.ok !== true || cleanup.testProfileDeleted !== true || cleanup.loginSessionDeleted !== true) {
        throw new Error('production_canary_cleanup_incomplete');
      }
    }
  }
}

main().catch(error => {
  const reason = error instanceof Error ? error.message : 'production_canary_failed';
  console.error(JSON.stringify({ lane: TARGET, ok: false,
    reasonCode: /^[a-z0-9_:.-]+$/.test(reason) ? reason : 'production_canary_failed' }));
  process.exitCode = 1;
});
