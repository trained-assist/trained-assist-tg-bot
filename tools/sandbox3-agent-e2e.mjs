#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { stopReplyConfirmsRequest } from './sandbox3-stop-confirmation.mjs';
import { summarizeStopDiagnostics } from './sandbox3-stop-diagnostics.mjs';

const ACCOUNT_ID = 'd740a05e9442c1d0feacae2dfc673e93';
const DATABASE_ID = '1e1b8108-9186-43e2-8e50-436598233165';
const PROFILE_ID = 'integration-sandbox3-v1';
const TG_ORIGIN = 'https://trained-assist-tg-sandbox3.skillset-apply.workers.dev';
let failureEvidenceWritten = false;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_required`);
  return value;
}

function pinnedIdentity() {
  const chatId = Number(required('TG_SANDBOX_E2E_CHAT_ID'));
  const userId = Number(required('TG_SANDBOX_E2E_USER_ID'));
  assert(Number.isSafeInteger(chatId) && chatId !== 0, 'sandbox3_test_chat_invalid');
  assert(Number.isSafeInteger(userId) && userId > 0, 'sandbox3_test_user_invalid');
  return { chatId, userId };
}

async function workerRequest(path, body) {
  const readyDeadline = Date.now() + 60_000;
  while (true) {
    const response = await fetch(`${TG_ORIGIN}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${required('TG_SANDBOX3_OPERATOR_TOKEN')}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
    const payload = await response.json().catch(() => ({}));
    if (response.ok) return payload;
    // A deploy can reach the health edge before its vars reach every Worker
    // isolate. This response is sent before update dispatch, so retry is safe.
    const updateIsNotReady = payload.error === 'sandbox_test_api_not_ready'
      || body?.type === 'callback' && ['no_current_button_message', 'no_current_button_revision'].includes(payload.error);
    if (path === '/operator/test-update' && response.status === 409
        && updateIsNotReady && Date.now() < readyDeadline) {
      await new Promise(resolve => setTimeout(resolve, 2_000));
      continue;
    }
    throw new Error(`sandbox3_worker_${path.replaceAll('/', '_')}_${response.status}_${payload.error ?? 'failed'}`);
  }
}

async function deliveryRead(taskId) {
  const response = await fetch(`${TG_ORIGIN}/operator/test-delivery/${encodeURIComponent(taskId)}`, {
    headers: { authorization: `Bearer ${required('TG_SANDBOX3_OPERATOR_TOKEN')}` },
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`sandbox3_delivery_read_${response.status}_${payload.error ?? 'failed'}`);
  return payload;
}

async function inspectStopDiagnostics(chatId, replyConfirmed, taskId) {
  let response;
  let payload = {};
  try {
    response = await fetch(`${TG_ORIGIN}/operator/stop-window`, {
      method: 'POST',
      headers: { authorization: `Bearer ${required('TG_SANDBOX3_OPERATOR_TOKEN')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'inspect', profileId: PROFILE_ID, chatId, threadId: null }),
      signal: AbortSignal.timeout(20_000),
    });
    payload = await response.json().catch(() => ({}));
  } catch {}
  const [task] = await d1('SELECT id, status, generation FROM durable_tasks WHERE id = ?', [taskId]);
  const taskEvidence = task ? await failedTaskEvidence(task) : null;
  return summarizeStopDiagnostics({ replyConfirmed, inspectStatus: response?.status, inspectPayload: payload, taskEvidence });
}

async function readStopWindow(chatId) {
  const response = await fetch(`${TG_ORIGIN}/operator/stop-window`, {
    method: 'POST',
    headers: { authorization: `Bearer ${required('TG_SANDBOX3_OPERATOR_TOKEN')}`, 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'inspect', profileId: PROFILE_ID, chatId, threadId: null }),
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => ({}));
  // The operator inspect endpoint is deliberately limited to a pending window;
  // once the DO window is no longer pending, 409 is expected and CP's terminal status is the
  // authoritative confirmation checked by waitForStopCompletion below.
  if (response.status === 409) return { available: false, pending: false, stopConfirmed: false,
    bufferedCount: null, collectorMessageId: null };
  if (!response.ok) throw new Error(`sandbox3_stop_window_inspect_${response.status}`);
  const entries = payload.snapshot?.entries;
  const window = entries?.cpStopWindow;
  if (!window || typeof window !== 'object') throw new Error('sandbox3_stop_window_missing');
  return {
    available: true,
    pending: window.pending === true,
    stopConfirmed: window.stopConfirmed === true,
    bufferedCount: (Array.isArray(entries.buf) ? entries.buf.length : 0)
      + (Array.isArray(entries.retryBatch) ? entries.retryBatch.length : 0),
    collectorMessageId: Number.isSafeInteger(entries.collectorMsgId) ? entries.collectorMsgId : null,
  };
}

async function waitForStopCompletion(chatId, taskId) {
  // The Intake DO retries an unresolved CP stop on its alarm (currently 60s).
  // Observe that durable path rather than treating the first pending response as
  // a failed stop or issuing a second cancellation from the test harness.
  const deadline = Date.now() + 3 * 60_000;
  let observed = null;
  while (Date.now() < deadline) {
    const [task] = await d1('SELECT status, generation FROM durable_tasks WHERE id = ?', [taskId]);
    const [execution] = await d1('SELECT status FROM executions WHERE task_id = ? ORDER BY started_at DESC LIMIT 1', [taskId]);
    const stopWindow = await readStopWindow(chatId);
    observed = { taskStatus: task?.status ?? 'missing', generation: task?.generation ?? null,
      executionStatus: execution?.status ?? 'missing', stopWindow };
    const terminal = task?.status === 'cancelled' && execution?.status === 'cancelled'
      && (!stopWindow.available || !stopWindow.pending && stopWindow.stopConfirmed);
    if (terminal) return observed;
    if (task?.status && ['done', 'failed', 'unknown'].includes(task.status)) {
      throw new Error(`sandbox3_stop_terminal_${task.status}`);
    }
    await new Promise(resolve => setTimeout(resolve, 3_000));
  }
  const diagnostics = await inspectStopDiagnostics(chatId, false, taskId);
  await writeEvidence({ ok: false, inputScenario: 'stop', reasonCode: 'sandbox_stop_confirmation_timeout', diagnostics });
  console.error(JSON.stringify({ lane: 'sandbox3', ok: false,
    reasonCode: 'sandbox_stop_confirmation_timeout', observed, diagnostics }));
  throw new Error('sandbox_stop_confirmation_timeout');
}

async function d1(sql, params = []) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`, {
    method: 'POST',
    headers: { authorization: `Bearer ${required('CF_API_TOKEN')}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sql, params }),
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success !== true) throw new Error(`sandbox3_d1_query_${response.status}`);
  const result = payload.result?.[0];
  if (!result || result.meta?.changed_db !== false || result.meta?.rows_written !== 0) {
    throw new Error('sandbox3_d1_read_only_contract_failed');
  }
  return result.results ?? [];
}

function safeCode(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : null;
}

async function failedTaskEvidence(task) {
  const [executions, events] = await Promise.all([
    d1('SELECT status, engine, generation FROM executions WHERE task_id = ? ORDER BY started_at', [task.id]),
    d1('SELECT kind, payload_json FROM task_events WHERE user_task_id = ? ORDER BY created_at DESC LIMIT 20', [task.id]),
  ]);
  const safeEvents = events.map(event => {
    let payload;
    try { payload = JSON.parse(event.payload_json ?? 'null'); } catch { payload = null; }
    const details = payload && typeof payload === 'object' ? payload : {};
    return {
      eventType: safeCode(event.kind) ?? 'unknown',
      reasonCode: safeCode(details.reasonCode) ?? safeCode(details.code) ?? null,
      stage: safeCode(details.stage) ?? null,
      errorClass: safeCode(details.errorClass) ?? null,
      where: safeCode(details.where) ?? null,
    };
  });
  return {
    status: safeCode(task.status) ?? 'unknown',
    generation: Number.isSafeInteger(task.generation) ? task.generation : null,
    executions: executions.map(row => ({
      status: safeCode(row.status) ?? 'unknown',
      engine: safeCode(row.engine),
      generation: Number.isSafeInteger(row.generation) ? row.generation : null,
    })),
    events: safeEvents,
  };
}

async function writeEvidence(report) {
  await writeFile('sandbox3-agent-e2e-evidence.json', `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  failureEvidenceWritten = true;
}

function assertDelivered(response, phase) {
  assert.equal(response.ok, true, 'worker_update_not_accepted');
  assert.equal(response.delivery, 'telegram', 'real_telegram_delivery_not_enabled');
  const sent = response.transcript?.filter(item => item.kind === 'sendMessage') ?? [];
  if (!sent.some(item => item.telegramOk === true && Number.isSafeInteger(item.messageId) && item.messageId > 0)) {
    const failed = sent.find(item => item.telegramOk !== true);
    const reason = failed?.errorClass ?? (failed ? 'send_was_suppressed' : 'no_send_record');
    throw new Error(`telegram_send_not_confirmed:${phase}:${reason}`);
  }
}

async function waitForTask(excludedTaskIds = []) {
  const deadline = Date.now() + 8 * 60_000;
  let rows = [];
  while (Date.now() < deadline) {
    rows = await d1(`SELECT id, status, goal, user_value, result_json, generation, delivery_state FROM durable_tasks WHERE profile_id = ? ORDER BY created_at DESC LIMIT 5`, [PROFILE_ID]);
    rows = rows.filter(row => !excludedTaskIds.includes(row.id));
    if (rows.length) {
      if (rows.length !== 1) throw new Error('sandbox3_unexpected_task_count');
      if (['failed', 'cancelled'].includes(rows[0].status)) {
        const diagnostic = await failedTaskEvidence(rows[0]);
        await writeEvidence({ ok: false, scenario: 'sandbox3-profile-login-question-runner-answer-telegram-delivery',
          inputScenario: process.env.SANDBOX3_E2E_SCENARIO ?? 'basic', task: diagnostic });
        console.error(JSON.stringify({ lane: 'sandbox3', ok: false, reasonCode: `sandbox3_task_${rows[0].status}`, task: diagnostic }));
        throw new Error(`sandbox3_task_${rows[0].status}`);
      }
      if (rows[0].status === 'done') return rows[0];
    }
    await new Promise(resolve => setTimeout(resolve, 8_000));
  }
  throw new Error(`sandbox3_task_timeout_${rows[0]?.status ?? 'not_admitted'}`);
}

async function waitForActiveTask(excludedTaskIds = []) {
  const deadline = Date.now() + 3 * 60_000;
  let rows = [];
  while (Date.now() < deadline) {
    rows = await d1(`SELECT t.id, t.status AS task_status, e.status AS execution_status
      FROM durable_tasks t JOIN executions e ON e.task_id = t.id
      WHERE t.profile_id = ? ORDER BY t.created_at DESC LIMIT 5`, [PROFILE_ID]);
    rows = rows.filter(row => !excludedTaskIds.includes(row.id));
    if (rows.length > 1) throw new Error('sandbox3_stop_unexpected_task_count');
    if (rows[0]?.execution_status === 'running') return rows[0];
    if (rows[0] && ['done', 'failed', 'cancelled'].includes(rows[0].task_status)) {
      throw new Error(`sandbox3_stop_task_ended_before_stop_${rows[0].task_status}`);
    }
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
  throw new Error(`sandbox3_stop_runner_never_started_${rows[0]?.task_status ?? 'not_admitted'}`);
}

async function waitForDelivery(taskId, chatId) {
  const deadline = Date.now() + 8 * 60_000;
  let observed;
  while (Date.now() < deadline) {
    observed = await deliveryRead(taskId);
    if (observed.terminal?.status === 'sent') {
      assert.equal(observed.terminal.chatId, chatId, 'answer_sent_to_unexpected_chat');
      assert(Number.isSafeInteger(observed.terminal.providerMessageId) && observed.terminal.providerMessageId > 0,
        'telegram_provider_message_id_missing');
      return observed.terminal;
    }
    if (['dead', 'unknown'].includes(observed.terminal?.status)) {
      throw new Error(`sandbox3_delivery_${observed.terminal.status}`);
    }
    await new Promise(resolve => setTimeout(resolve, 5_000));
  }
  throw new Error(`sandbox3_delivery_timeout_${observed?.terminal?.status ?? 'not_enqueued'}`);
}

async function verifyGatewayOwnedDelivery(taskId, taskDeliveryState) {
  const [projection] = await d1(`SELECT count(*) AS row_count FROM deliveries WHERE user_task_id = ?`, [taskId]);
  assert.equal(taskDeliveryState, 'not_required', 'sandbox3_telegram_delivery_is_owned_by_gateway');
  assert.equal(projection?.row_count, 0, 'sandbox3_unexpected_control_plane_delivery_rows');
  return { state: taskDeliveryState, rows: projection.row_count };
}

async function main() {
  if (process.env.TG_SANDBOX_TARGET !== 'sandbox3') throw new Error('sandbox3_target_required');
  if (process.env.CLOUDFLARE_ACCOUNT_ID !== ACCOUNT_ID) throw new Error('sandbox3_account_mismatch');
  const scenario = process.env.SANDBOX3_E2E_SCENARIO ?? 'basic';
  assert(['basic', 'multiline', 'history', 'stop'].includes(scenario), 'sandbox3_scenario_invalid');
  const { chatId, userId } = pinnedIdentity();
  const nonce = `E2E-${randomBytes(8).toString('hex').toUpperCase()}`;
  const prompt = scenario === 'multiline'
    ? `Reply with exactly these three lines and preserve their line breaks:\n${nonce}-LINE-1\n${nonce}-LINE-2\n${nonce}-LINE-3`
    : scenario === 'history'
      ? `Remember this token for my next question: ${nonce}. Reply with exactly READY and nothing else.`
      : `Reply with exactly this token and nothing else: ${nonce}`;
  const expectedLines = scenario === 'multiline'
    ? [`${nonce}-LINE-1`, `${nonce}-LINE-2`, `${nonce}-LINE-3`]
    : scenario === 'history' ? ['READY'] : [nonce];
  const username = `e2e_${randomBytes(6).toString('hex')}`;
  let updateId = Date.now();
  const sendMessage = (text, extra = {}) => workerRequest('/operator/test-update', {
    target: 'sandbox3', type: 'message', chatId, userId, delivery: 'telegram',
    updateId: updateId++, text, ...extra,
  });

  // Exercise separate HTTP requests through the live Worker with the same
  // pinned chat. A module-level TEST_CHAT_IDS cache from a prior request must
  // never suppress a later real delivery.
  const help = await sendMessage('/help');
  assertDelivered(help, 'help-real-delivery');
  const status = await sendMessage('/status');
  assertDelivered(status, 'status-after-help-real-delivery');
  console.log(JSON.stringify({ scenario: 'cross-request-real-delivery',
    helpDelivered: true, statusDeliveredAfterSeparateWorkerRequest: true }));

  // Keep the generated password inside the Actions process; never send it to
  // the shared test chat. The actual login reply and task answer use Telegram.
  const created = await sendMessage(`/adduser ${username} Sandbox E2E`, { admin: true, delivery: 'capture' });
  assert.equal(created.ok, true, 'sandbox_test_profile_not_created');
  assert.equal(created.delivery, 'capture', 'sandbox_test_profile_creation_must_stay_private');
  const createdText = created.transcript.map(item => String(item.text ?? '')).join('\n');
  assert(createdText.includes(username), 'sandbox_test_profile_not_created');
  const passwordMatch = /Пароль:\s*<code>([^<]+)<\/code>/i.exec(createdText);
  assert(passwordMatch?.[1], 'sandbox_test_password_not_returned');

  const login = await sendMessage(`/login ${username} ${passwordMatch[1]}`);
  assertDelivered(login, 'login');
  assert.equal(login.admission?.authenticated, true, 'sandbox_test_login_failed');

  const questionUpdateId = updateId++;
  const questionUpdate = {
    target: 'sandbox3', type: 'message', chatId, userId, delivery: 'telegram',
    updateId: questionUpdateId, text: prompt,
  };
  const question = await workerRequest('/operator/test-update', questionUpdate);
  // The message is acknowledged by the Intake Durable Object, which runs in a
  // separate Worker isolate; its Telegram sends are not part of this request's
  // operator transcript. Verify admission here and verify the real terminal
  // answer through the delivery owner below.
  assert.equal(question.ok, true, 'sandbox_question_not_accepted');
  assert.equal(question.collector?.pendingCount, 1, 'question_not_in_intake_buffer');
  const replay = await workerRequest('/operator/test-update', questionUpdate);
  assert.equal(replay.ok, true, 'sandbox_duplicate_update_not_acknowledged');
  assert.equal(replay.collector?.pendingCount, 1, 'duplicate_update_added_input_twice');
  console.log(JSON.stringify({ scenario: 'duplicate-telegram-update-replay',
    sameUpdateReplayed: true, pendingCountBeforeReplay: question.collector.pendingCount,
    pendingCountAfterReplay: replay.collector.pendingCount }));

  const launched = await workerRequest('/operator/test-update', {
    target: 'sandbox3', type: 'callback', chatId, userId, delivery: 'telegram',
    callbackData: 'auto', updateId: updateId++,
  });
  assert.equal(launched.ok, true, 'sandbox_task_launch_callback_failed');

  const task = await waitForTask();
  assert(typeof task.goal === 'string' && task.goal.includes(nonce), 'sandbox3_input_not_persisted');
  let storedUserValue;
  try { storedUserValue = JSON.parse(task.user_value ?? 'null'); } catch { storedUserValue = null; }
  const storedInputItems = Array.isArray(storedUserValue?.inputItems) ? storedUserValue.inputItems : [];
  const storedInputText = storedInputItems
    .map(item => item && typeof item.text === 'string' ? item.text : '')
    .filter(Boolean)
    .join('\n');
  const originalInputPersisted = storedInputText.includes(prompt);
  const expectedLineBreaks = (prompt.match(/\n/g) ?? []).length;
  const persistedLineBreaks = (storedInputText.match(/\n/g) ?? []).length;
  console.log(JSON.stringify({ scenario: 'original-input-persistence', inputScenario: scenario,
    originalInputPersisted, expectedLineBreaks, persistedLineBreaks, inputItemCount: storedInputItems.length }));
  assert(originalInputPersisted, 'sandbox3_original_input_not_persisted');
  const [routingRow] = await d1('SELECT payload_json FROM task_events WHERE event_id = ?', [`routing:${task.id}:${task.generation}`]);
  assert(routingRow?.payload_json, 'sandbox3_routing_selection_not_persisted');
  const routing = JSON.parse(routingRow.payload_json);
  const providerCode = typeof routing.decision?.providerCode === 'string'
    && /^[a-z0-9_:-]{1,64}$/.test(routing.decision.providerCode) ? routing.decision.providerCode : 'unknown';
  const communicationReasonCode = routing.decision?.reasonCode;
  const communicationOutcome = communicationReasonCode === 'COMMUNICATION_SELECTED' ? 'selected'
    : communicationReasonCode === 'COMMUNICATION_FALLBACK' ? 'agent_fallback' : null;
  console.log(JSON.stringify({ scenario: 'communication-selector', route: routing.decision?.route ?? null,
    outcome: communicationOutcome, reasonCode: communicationReasonCode ?? null, providerCode }));
  assert.equal(routing.decision?.route, 'agent', 'sandbox3_selector_did_not_select_agent');
  assert(communicationOutcome, `sandbox3_communication_route_${providerCode}`);
  assert(routing.continuation, 'sandbox3_agent_continuation_not_requested');
  const executions = await d1(`SELECT id, status, session_id, engine, generation FROM executions WHERE task_id = ? ORDER BY started_at`, [task.id]);
  assert.equal(executions.length, 1, 'sandbox_task_execution_count_not_one');
  assert.equal(executions[0].status, 'success', 'sandbox_runner_execution_not_successful');
  assert.equal(executions[0].generation, task.generation, 'sandbox_runner_generation_mismatch');
  assert(typeof executions[0].engine === 'string' && executions[0].engine.length > 0, 'sandbox_runner_engine_missing');
  assert(Number.isSafeInteger(executions[0].generation), 'sandbox_runner_generation_missing');
  assert(typeof executions[0].session_id === 'string' && executions[0].session_id.length > 0, 'sandbox_runner_session_missing');
  let resultValue = task.result_json;
  if (typeof resultValue === 'string') {
    try { resultValue = JSON.parse(resultValue); } catch { /* retain plain text */ }
  }
  const answerParts = [];
  const collectText = value => {
    if (typeof value === 'string') answerParts.push(value);
    else if (Array.isArray(value)) value.forEach(collectText);
    else if (value && typeof value === 'object') Object.values(value).forEach(collectText);
  };
  collectText(resultValue);
  const resultText = answerParts.join('\n');
  const escapedLines = expectedLines.map(line => line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const answerMatchesChallenge = new RegExp(escapedLines.join('\\s*\\r?\\n\\s*'), 'i').test(resultText);
  assert(answerMatchesChallenge, 'sandbox_answer_did_not_match_challenge');
  const terminal = await waitForDelivery(task.id, chatId);
  const cpDelivery = await verifyGatewayOwnedDelivery(task.id, task.delivery_state);

  let historyEvidence = null;
  if (scenario === 'history') {
    const followupPrompt = `What exact token did I ask you to remember? Reply with that token only.`;
    const followup = await sendMessage(followupPrompt);
    assert.equal(followup.ok, true, 'sandbox_history_followup_not_accepted');
    assert.equal(followup.collector?.pendingCount, 1, 'sandbox_history_followup_not_buffered');
    const followupLaunch = await workerRequest('/operator/test-update', {
      target: 'sandbox3', type: 'callback', chatId, userId, delivery: 'telegram',
      callbackData: 'auto', updateId: updateId++,
    });
    assert.equal(followupLaunch.ok, true, 'sandbox_history_followup_launch_failed');
    const followupTask = await waitForTask([task.id]);
    assert.notEqual(followupTask.id, task.id, 'sandbox_history_followup_reused_task_id');
    assert(typeof followupTask.goal === 'string' && followupTask.goal.includes(followupPrompt),
      'sandbox_history_followup_input_not_persisted');
    const followupExecutions = await d1(`SELECT id, status, session_id, generation FROM executions WHERE task_id = ? ORDER BY started_at`, [followupTask.id]);
    assert.equal(followupExecutions.length, 1, 'sandbox_history_followup_execution_count_not_one');
    assert.equal(followupExecutions[0].status, 'success', 'sandbox_history_followup_runner_not_successful');
    const followupResult = await d1(`SELECT result_json FROM durable_tasks WHERE id = ?`, [followupTask.id]);
    let followupText = '';
    const collectFollowupText = value => {
      if (typeof value === 'string') followupText += `${value}\n`;
      else if (Array.isArray(value)) value.forEach(collectFollowupText);
      else if (value && typeof value === 'object') Object.values(value).forEach(collectFollowupText);
    };
    collectFollowupText(followupResult[0]?.result_json);
    assert(followupText.includes(nonce), 'sandbox_history_previous_turn_not_recalled');
    const followupDelivery = await waitForDelivery(followupTask.id, chatId);
    const followupRoutingRows = await d1('SELECT payload_json FROM task_events WHERE event_id = ?',
      [`routing:${followupTask.id}:${followupTask.generation}`]);
    const followupRouting = JSON.parse(followupRoutingRows[0]?.payload_json ?? 'null');
    assert(followupRouting?.continuation, 'sandbox_history_continuation_not_requested');
    historyEvidence = {
      previousTurnRecalled: true,
      distinctTaskIds: true,
      followupExecutionCount: followupExecutions.length,
      followupDelivered: followupDelivery.status === 'sent',
      continuationRequested: true,
    };
    console.log(JSON.stringify({ scenario: 'conversation-history-followup', ...historyEvidence }));
  }

  let stopEvidence = null;
  if (scenario === 'stop') {
    const stopToken = `STOP-${randomBytes(6).toString('hex').toUpperCase()}`;
    const stopPrompt = `Use your shell tool to run the harmless command \`sleep 120\` and wait for it to finish. Only then reply with exactly this token: ${stopToken}`;
    const stopQuestion = await sendMessage(stopPrompt);
    assert.equal(stopQuestion.ok, true, 'sandbox_stop_question_not_accepted');
    assert.equal(stopQuestion.collector?.pendingCount, 1, 'sandbox_stop_question_not_buffered');
    const stopLaunch = await workerRequest('/operator/test-update', {
      target: 'sandbox3', type: 'callback', chatId, userId, delivery: 'telegram',
      callbackData: 'auto', updateId: updateId++,
    });
    assert.equal(stopLaunch.ok, true, 'sandbox_stop_task_launch_failed');
    const active = await waitForActiveTask([task.id]);
    const stopReply = await sendMessage('/stop');
    assertDelivered(stopReply, 'active-task-stop');
    const stopText = (stopReply.transcript ?? []).map(item => String(item.text ?? '')).join('\n').toLowerCase();
    const immediateStopConfirmed = stopReplyConfirmsRequest(stopText);

    const freshToken = `AFTER-STOP-${randomBytes(6).toString('hex').toUpperCase()}`;
    const freshPrompt = `Reply with exactly this token and nothing else: ${freshToken}`;
    let freshQuestion = null;
    let inputBufferedWhileStopPending = false;
    if (!immediateStopConfirmed) {
      const pending = await readStopWindow(chatId);
      if (pending.pending) {
        freshQuestion = await sendMessage(freshPrompt);
        assert.equal(freshQuestion.ok, true, 'sandbox_after_stop_question_not_accepted');
        assert.equal(freshQuestion.collector?.pendingCount, 1, 'sandbox_after_stop_question_not_buffered');
        inputBufferedWhileStopPending = true;
      } else if (pending.available && pending.stopConfirmed) {
        // Cancellation settled between the /stop reply and this read. Send the
        // next question after confirmation; CP terminal evidence is still checked.
      } else {
        assert.equal(pending.available, false, 'sandbox_stop_window_not_marked_pending');
      }
    }
    const stopCompletion = await waitForStopCompletion(chatId, active.id);
    const terminalStatus = stopCompletion.taskStatus;
    const stoppedExecutions = await d1('SELECT status FROM executions WHERE task_id = ? ORDER BY started_at', [active.id]);
    assert.equal(stoppedExecutions.length, 1, 'sandbox_stop_execution_count_not_one');
    assert.notEqual(stoppedExecutions[0].status, 'running', 'sandbox_stop_execution_still_running');

    if (!freshQuestion) {
      freshQuestion = await sendMessage(freshPrompt);
      assert.equal(freshQuestion.ok, true, 'sandbox_after_stop_question_not_accepted');
      assert.equal(freshQuestion.collector?.pendingCount, 1, 'sandbox_after_stop_question_not_buffered');
    }
    const freshLaunch = await workerRequest('/operator/test-update', {
      target: 'sandbox3', type: 'callback', chatId, userId, delivery: 'telegram',
      callbackData: 'auto', updateId: updateId++,
    });
    assert.equal(freshLaunch.ok, true, 'sandbox_after_stop_launch_failed');
    const freshCollector = freshLaunch.collector ?? {};
    const freshBarrier = freshCollector.controlPlaneBarrier ?? {};
    const freshLaunchObserved = freshCollector.pendingCount === 0 || freshCollector.busy === true
      || freshCollector.launchingMessageIds?.length > 0
      || Number(freshBarrier.busyRequestCount ?? 0) > 0
      || Number(freshBarrier.unresolvedLaunchCount ?? 0) > 0;
    console.log(JSON.stringify({ scenario: 'after-stop-launch-accepted',
      pendingCount: Number.isSafeInteger(freshCollector.pendingCount) ? freshCollector.pendingCount : null,
      busy: freshCollector.busy === true,
      launchingCount: Array.isArray(freshCollector.launchingMessageIds) ? freshCollector.launchingMessageIds.length : null,
      busyRequestCount: Number.isSafeInteger(freshBarrier.busyRequestCount) ? freshBarrier.busyRequestCount : null,
      unresolvedLaunchCount: Number.isSafeInteger(freshBarrier.unresolvedLaunchCount) ? freshBarrier.unresolvedLaunchCount : null,
      callbackAccepted: freshLaunch.admission?.ok === true }));
    assert(freshLaunchObserved, 'sandbox_after_stop_launch_not_dispatched');
    const freshTask = await waitForTask([task.id, active.id]);
    assert(typeof freshTask.goal === 'string' && freshTask.goal.includes(freshPrompt), 'sandbox_after_stop_input_not_persisted');
    const freshExecution = await d1('SELECT status FROM executions WHERE task_id = ? ORDER BY started_at', [freshTask.id]);
    assert.equal(freshExecution.length, 1, 'sandbox_after_stop_execution_count_not_one');
    assert.equal(freshExecution[0].status, 'success', 'sandbox_after_stop_runner_not_successful');
    const freshResult = await d1('SELECT result_json FROM durable_tasks WHERE id = ?', [freshTask.id]);
    assert(String(freshResult[0]?.result_json ?? '').includes(freshToken), 'sandbox_after_stop_answer_mismatch');
    const freshDelivery = await waitForDelivery(freshTask.id, chatId);
    stopEvidence = {
      activeTaskObserved: true,
      stopConfirmedByWorker: true,
      immediateStopConfirmed,
      inputBufferedWhileStopPending,
      stoppedTaskTerminalStatus: terminalStatus,
      stopWindowInspectableAtConfirmation: stopCompletion.stopWindow.available,
      stoppedExecutionNotRunning: true,
      freshTaskCompleted: true,
      freshAnswerDelivered: freshDelivery.status === 'sent',
    };
    console.log(JSON.stringify({ scenario: 'active-task-stop-and-next-task', ...stopEvidence }));
  }

  const report = {
    ok: true,
    scenario: 'sandbox3-profile-login-question-runner-answer-telegram-delivery',
    inputScenario: scenario,
    sourceSha: process.env.GITHUB_SHA ?? null,
    communicationOutcome,
    communicationReasonCode,
    communicationProviderCode: providerCode,
    loginPassed: true,
    questionAccepted: true,
    taskTerminalDone: task.status === 'done',
    runnerExecutionSuccess: executions[0].status === 'success',
    runnerExecutionCount: executions.length,
    answerMatchesChallenge,
    telegramDeliverySent: terminal.status === 'sent',
    telegramProviderMessageIdPresent: true,
    deliveryAttempts: terminal.attempts,
    telegramDeliveryOwner: 'sandbox3-intake',
    controlPlaneDeliveryState: cpDelivery.state,
    controlPlaneDeliveryRows: cpDelivery.rows,
    ...(historyEvidence ? { historyEvidence } : {}),
    ...(stopEvidence ? { stopEvidence } : {}),
  };
  await writeEvidence(report);
  console.log(JSON.stringify(report));
}

main().catch(async error => {
  const message = error instanceof Error ? error.message : '';
  const safe = /^[a-z0-9_:.-]+$/.test(message) ? message : 'sandbox3_agent_e2e_failed';
  if (!failureEvidenceWritten) {
    await writeEvidence({ ok: false, inputScenario: process.env.SANDBOX3_E2E_SCENARIO ?? 'basic', reasonCode: safe });
  }
  console.error(JSON.stringify({ lane: 'sandbox3', ok: false, reasonCode: safe }));
  process.exitCode = 1;
});
