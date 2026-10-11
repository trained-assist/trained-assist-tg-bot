#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const ACCOUNT_ID = 'd740a05e9442c1d0feacae2dfc673e93';
const DATABASE_ID = '1e1b8108-9186-43e2-8e50-436598233165';
const PROFILE_ID = 'integration-sandbox3-v1';
const TG_ORIGIN = 'https://trained-assist-tg-sandbox3.skillset-apply.workers.dev';

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

async function waitForTask() {
  const deadline = Date.now() + 8 * 60_000;
  let rows = [];
  while (Date.now() < deadline) {
    rows = await d1(`SELECT id, status, goal, user_value, result_json, generation, delivery_state FROM durable_tasks WHERE profile_id = ? ORDER BY created_at DESC LIMIT 2`, [PROFILE_ID]);
    if (rows.length) {
      if (rows.length !== 1) throw new Error('sandbox3_unexpected_task_count');
      if (['failed', 'cancelled'].includes(rows[0].status)) throw new Error(`sandbox3_task_${rows[0].status}`);
      if (rows[0].status === 'done') return rows[0];
    }
    await new Promise(resolve => setTimeout(resolve, 8_000));
  }
  throw new Error(`sandbox3_task_timeout_${rows[0]?.status ?? 'not_admitted'}`);
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
  assert(['basic', 'multiline'].includes(scenario), 'sandbox3_scenario_invalid');
  const { chatId, userId } = pinnedIdentity();
  const nonce = `E2E-${randomBytes(8).toString('hex').toUpperCase()}`;
  const prompt = scenario === 'multiline'
    ? `Reply with exactly these three lines and preserve their line breaks:\n${nonce}-LINE-1\n${nonce}-LINE-2\n${nonce}-LINE-3`
    : `Reply with exactly this token and nothing else: ${nonce}`;
  const expectedLines = scenario === 'multiline'
    ? [`${nonce}-LINE-1`, `${nonce}-LINE-2`, `${nonce}-LINE-3`]
    : [nonce];
  const username = `e2e_${randomBytes(6).toString('hex')}`;
  let updateId = Date.now();
  const sendMessage = (text, extra = {}) => workerRequest('/operator/test-update', {
    target: 'sandbox3', type: 'message', chatId, userId, delivery: 'telegram',
    updateId: updateId++, text, ...extra,
  });

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

  const question = await sendMessage(prompt);
  // The message is acknowledged by the Intake Durable Object, which runs in a
  // separate Worker isolate; its Telegram sends are not part of this request's
  // operator transcript. Verify admission here and verify the real terminal
  // answer through the delivery owner below.
  assert.equal(question.ok, true, 'sandbox_question_not_accepted');
  assert.equal(question.collector?.pendingCount, 1, 'question_not_in_intake_buffer');

  const launched = await workerRequest('/operator/test-update', {
    target: 'sandbox3', type: 'callback', chatId, userId, delivery: 'telegram',
    callbackData: 'auto', updateId: updateId++,
  });
  assert.equal(launched.ok, true, 'sandbox_task_launch_callback_failed');

  const task = await waitForTask();
  assert(typeof task.goal === 'string' && task.goal.includes(nonce), 'sandbox3_input_not_persisted');
  assert(typeof task.user_value === 'string' && task.user_value.includes(prompt), 'sandbox3_original_input_not_persisted');
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
  };
  await writeFile('sandbox3-agent-e2e-evidence.json', `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(report));
}

main().catch(error => {
  const message = error instanceof Error ? error.message : '';
  const safe = /^[a-z0-9_:.-]+$/.test(message) ? message : 'sandbox3_agent_e2e_failed';
  console.error(JSON.stringify({ lane: 'sandbox3', ok: false, reasonCode: safe }));
  process.exitCode = 1;
});
