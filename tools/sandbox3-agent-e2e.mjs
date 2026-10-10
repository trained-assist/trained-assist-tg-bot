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
  const response = await fetch(`${TG_ORIGIN}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${required('TG_SANDBOX3_OPERATOR_TOKEN')}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`sandbox3_worker_${path.replaceAll('/', '_')}_${response.status}_${payload.error ?? 'failed'}`);
  return payload;
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

function assertDelivered(response) {
  assert.equal(response.ok, true, 'worker_update_not_accepted');
  assert.equal(response.delivery, 'telegram', 'real_telegram_delivery_not_enabled');
  const sent = response.transcript?.filter(item => item.kind === 'sendMessage') ?? [];
  if (!sent.some(item => item.telegramOk === true && Number.isSafeInteger(item.messageId) && item.messageId > 0)) {
    const code = sent.find(item => Number.isSafeInteger(item.errorCode))?.errorCode ?? 'unknown';
    throw new Error(`telegram_send_not_confirmed:${code}`);
  }
}

async function waitForTask() {
  const deadline = Date.now() + 8 * 60_000;
  let rows = [];
  while (Date.now() < deadline) {
    rows = await d1(`SELECT id, status, result_json, generation FROM durable_tasks WHERE profile_id = ? ORDER BY created_at DESC LIMIT 2`, [PROFILE_ID]);
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

async function waitForCpDelivery(taskId) {
  const deadline = Date.now() + 2 * 60_000;
  let rows = [];
  while (Date.now() < deadline) {
    rows = await d1(`SELECT t.delivery_state, d.status FROM durable_tasks t
      LEFT JOIN deliveries d ON d.user_task_id = t.id WHERE t.id = ? ORDER BY d.created_at`, [taskId]);
    if (rows.length && rows.every(row => row.delivery_state === 'delivered' && row.status === 'delivered')) return rows;
    if (rows.some(row => ['failed', 'unknown'].includes(row.status))) throw new Error('sandbox3_cp_delivery_not_delivered');
    await new Promise(resolve => setTimeout(resolve, 5_000));
  }
  throw new Error(`sandbox3_cp_delivery_timeout_${rows[0]?.delivery_state ?? 'missing'}`);
}

async function main() {
  if (process.env.TG_SANDBOX_TARGET !== 'sandbox3') throw new Error('sandbox3_target_required');
  if (process.env.CLOUDFLARE_ACCOUNT_ID !== ACCOUNT_ID) throw new Error('sandbox3_account_mismatch');
  const { chatId, userId } = pinnedIdentity();
  const nonce = `E2E-${randomBytes(8).toString('hex').toUpperCase()}`;
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
  assertDelivered(login);
  assert.equal(login.admission?.authenticated, true, 'sandbox_test_login_failed');

  const question = await sendMessage(`Reply with exactly this token and nothing else: ${nonce}`);
  assertDelivered(question);
  assert.equal(question.collector?.pendingCount, 1, 'question_not_in_intake_buffer');
  assert(Number.isSafeInteger(question.collector?.collectorMessageId), 'intake_launch_button_missing');

  const launched = await workerRequest('/operator/test-update', {
    target: 'sandbox3', type: 'callback', chatId, userId, delivery: 'telegram',
    callbackData: 'auto', messageId: question.collector.collectorMessageId, updateId: updateId++,
  });
  assert.equal(launched.ok, true, 'sandbox_task_launch_callback_failed');

  const task = await waitForTask();
  assert(typeof task.goal === 'string' && task.goal.includes(nonce), 'sandbox3_input_not_persisted');
  const executions = await d1(`SELECT id, status, session_id, engine, generation FROM executions WHERE task_id = ? ORDER BY started_at`, [task.id]);
  assert.equal(executions.length, 1, 'sandbox_task_execution_count_not_one');
  assert.equal(executions[0].status, 'success', 'sandbox_runner_execution_not_successful');
  assert.equal(executions[0].generation, task.generation, 'sandbox_runner_generation_mismatch');
  assert(typeof executions[0].engine === 'string' && executions[0].engine.length > 0, 'sandbox_runner_engine_missing');
  assert(Number.isSafeInteger(executions[0].generation), 'sandbox_runner_generation_missing');
  assert(typeof executions[0].session_id === 'string' && executions[0].session_id.length > 0, 'sandbox_runner_session_missing');
  const resultText = typeof task.result_json === 'string' ? task.result_json : JSON.stringify(task.result_json ?? '');
  assert(resultText.toLowerCase().includes(nonce.toLowerCase()), 'sandbox_answer_did_not_match_challenge');
  const terminal = await waitForDelivery(task.id, chatId);
  const cpDeliveries = await waitForCpDelivery(task.id);

  const report = {
    ok: true,
    scenario: 'sandbox3-profile-login-question-runner-answer-telegram-delivery',
    sourceSha: process.env.GITHUB_SHA ?? null,
    loginPassed: true,
    questionAccepted: true,
    taskTerminalDone: task.status === 'done',
    runnerExecutionSuccess: executions[0].status === 'success',
    runnerExecutionCount: executions.length,
    answerMatchesChallenge: true,
    telegramDeliverySent: terminal.status === 'sent',
    telegramProviderMessageIdPresent: true,
    deliveryAttempts: terminal.attempts,
    controlPlaneDeliveryRows: cpDeliveries.length,
    controlPlaneDeliveryTerminal: cpDeliveries.every(row => row.status === 'delivered'),
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
