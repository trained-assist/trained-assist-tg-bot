#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const ACCOUNT_ID = 'd740a05e9442c1d0feacae2dfc673e93';
const DATABASE_ID = '01d17f46-63e2-46bc-947d-9eda3e0bb697';
const TG_ORIGIN = 'https://trained-assist-tg-ux-sandbox.skillset-apply.workers.dev';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_required`);
  return value;
}

const chatId = Number(required('TG_SANDBOX_E2E_CHAT_ID'));
const userId = Number(required('TG_SANDBOX_E2E_USER_ID'));
assert(Number.isSafeInteger(chatId) && chatId > 0, 'probability_test_chat_invalid');
assert(Number.isSafeInteger(userId) && userId > 0, 'probability_test_user_invalid');

async function workerRequest(path, body) {
  const readyDeadline = Date.now() + 60_000;
  while (true) {
    const response = await fetch(`${TG_ORIGIN}${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${required('TG_SANDBOX_CLEANUP_TOKEN')}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(180_000),
    });
    const payload = await response.json().catch(() => ({}));
    if (response.ok) return payload;
    // The callback is a safe retry: Intake returns these refusals before
    // dispatching the buffered update or creating a CP task. The collector
    // button can appear shortly after the message enters its Durable Object.
    const updateIsNotReady = payload.error === 'sandbox_test_api_not_ready'
      || body?.type === 'callback' && ['no_current_button_message', 'no_current_button_revision'].includes(payload.error);
    if (path === '/operator/test-update' && response.status === 409
        && updateIsNotReady && Date.now() < readyDeadline) {
      await new Promise(resolve => setTimeout(resolve, 2_000));
      continue;
    }
    throw new Error(`probability_worker_${path.replaceAll('/', '_')}_${response.status}:${payload.error ?? 'failed'}`);
  }
}

async function d1(sql, params = []) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`, {
    method: 'POST', headers: { authorization: `Bearer ${required('CF_API_TOKEN')}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sql, params }), signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success !== true) throw new Error(`probability_cp_d1_query_${response.status}`);
  const result = payload.result?.[0];
  if (!result || result.meta?.changed_db !== false || result.meta?.rows_written !== 0) {
    throw new Error('probability_d1_read_only_contract_failed');
  }
  return result.results ?? [];
}

async function waitForTask(nonce) {
  const deadline = Date.now() + 8 * 60_000;
  let rows = [];
  while (Date.now() < deadline) {
    rows = await d1(`SELECT id, status, goal, result_json, generation, delivery_state
      FROM durable_tasks WHERE goal LIKE ? ORDER BY created_at DESC LIMIT 5`, [`%${nonce}%`]);
    if (rows.length > 1) throw new Error('probability_duplicate_cp_tasks');
    if (rows[0]?.status === 'failed' || rows[0]?.status === 'cancelled') {
      throw new Error(`probability_task_${rows[0].status}`);
    }
    if (rows[0]?.status === 'done') return rows[0];
    await new Promise(resolve => setTimeout(resolve, 8_000));
  }
  throw new Error(`probability_task_timeout_${rows[0]?.status ?? 'not_admitted'}`);
}

async function waitForDelivery(taskId) {
  const deadline = Date.now() + 3 * 60_000;
  let observed;
  while (Date.now() < deadline) {
    const response = await fetch(`${TG_ORIGIN}/operator/test-delivery/${encodeURIComponent(taskId)}?chatId=${chatId}`, {
      headers: { authorization: `Bearer ${required('TG_SANDBOX_CLEANUP_TOKEN')}` },
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`probability_delivery_read_${response.status}:${payload.error ?? 'failed'}`);
    observed = payload.terminal;
    if (observed?.status === 'sent') {
      assert.equal(String(observed.chatId), String(chatId), 'probability_answer_sent_to_unexpected_chat');
      assert(Number.isSafeInteger(observed.providerMessageId) && observed.providerMessageId > 0,
        'probability_provider_message_id_missing');
      return observed;
    }
    if (['dead', 'unknown'].includes(observed?.status)) throw new Error(`probability_delivery_${observed.status}`);
    await new Promise(resolve => setTimeout(resolve, 5_000));
  }
  throw new Error(`probability_delivery_timeout_${observed?.status ?? 'not_enqueued'}`);
}

function assertDelivered(response, phase) {
  assert.equal(response.delivery, 'telegram', `probability_${phase}_real_delivery_not_enabled`);
  const sent = response.transcript?.filter(item => item.kind === 'sendMessage') ?? [];
  assert(sent.some(item => item.telegramOk === true && Number.isSafeInteger(item.messageId) && item.messageId > 0),
    `probability_${phase}_telegram_send_not_confirmed`);
}

async function main() {
  const [before] = await d1('SELECT COUNT(*) AS n FROM durable_tasks');
  assert.equal(Number(before.n), 0, 'probability_cp_task_store_not_empty');
  let updateId = Date.now();
  const send = (text, extra = {}) => workerRequest('/operator/test-update', {
    target: 'sandbox', type: 'message', chatId, userId, delivery: 'telegram', updateId: updateId++, text, ...extra,
  });

  const help = await send('/help');
  assert.equal(help.ok, true);
  assertDelivered(help, 'help');
  const status = await send('/status');
  assert.equal(status.ok, true);
  assertDelivered(status, 'status');
  const [afterCommands] = await d1('SELECT COUNT(*) AS n FROM durable_tasks');
  assert.equal(Number(afterCommands.n), 0, 'probability_service_commands_created_task');

  const username = `e2e_${randomBytes(6).toString('hex')}`;
  const created = await workerRequest('/operator/test-update', {
    target: 'sandbox', type: 'message', chatId, userId, delivery: 'capture', admin: true,
    updateId: updateId++, text: `/adduser ${username} Sandbox E2E`,
  });
  assert.equal(created.ok, true, 'probability_test_profile_not_created');
  const createdText = (created.transcript ?? []).map(item => String(item.text ?? '')).join('\n');
  assert(createdText.includes(username), 'probability_test_profile_not_created');
  const password = /Пароль:\s*<code>([^<]+)<\/code>/i.exec(createdText)?.[1];
  assert(password, 'probability_test_password_not_returned');

  const login = await send(`/login ${username} ${password}`);
  assert.equal(login.admission?.authenticated, true, 'probability_test_login_failed');
  assertDelivered(login, 'login');

  const nonce = `E2E-${randomBytes(8).toString('hex').toUpperCase()}`;
  const prompt = `Reply with exactly this token and nothing else: ${nonce}`;
  const questionId = updateId++;
  const questionInput = { target: 'sandbox', type: 'message', chatId, userId, delivery: 'telegram',
    updateId: questionId, text: prompt };
  const question = await workerRequest('/operator/test-update', questionInput);
  assert.equal(question.ok, true, 'probability_question_not_accepted');
  assert.equal(question.collector?.pendingCount, 1, 'probability_question_not_buffered');
  const replay = await workerRequest('/operator/test-update', questionInput);
  assert.equal(replay.ok, true, 'probability_duplicate_update_not_acknowledged');
  assert.equal(replay.collector?.pendingCount, 1, 'probability_duplicate_update_added_input_twice');

  const launched = await workerRequest('/operator/test-update', {
    target: 'sandbox', type: 'callback', chatId, userId, delivery: 'telegram',
    callbackData: 'auto', updateId: updateId++,
  });
  assert.equal(launched.ok, true, 'probability_task_launch_failed');
  const task = await waitForTask(nonce);
  assert(task.goal.includes(prompt), 'probability_original_input_not_persisted');
  assert(Number.isSafeInteger(task.generation) && task.generation > 0, 'probability_task_generation_missing');
  const executions = await d1(`SELECT id, status, session_id, engine, generation FROM executions
    WHERE task_id = ? ORDER BY started_at`, [task.id]);
  assert.equal(executions.length, 1, 'probability_execution_count_not_one');
  assert.equal(executions[0].status, 'success', 'probability_runner_execution_not_successful');
  assert.equal(executions[0].generation, task.generation, 'probability_runner_generation_mismatch');
  assert(typeof executions[0].session_id === 'string' && executions[0].session_id.length > 0,
    'probability_runner_id_missing');
  let result = task.result_json;
  if (typeof result === 'string') {
    try { result = JSON.parse(result); } catch { /* plain text result */ }
  }
  const resultText = typeof result === 'string' ? result : JSON.stringify(result);
  assert(resultText.includes(nonce), 'probability_answer_mismatch');
  const delivery = await waitForDelivery(task.id);
  const [cpDeliveryRows] = await d1('SELECT COUNT(*) AS n FROM deliveries WHERE user_task_id = ?', [task.id]);
  assert.equal(Number(cpDeliveryRows.n), 0, 'probability_unexpected_cp_delivery_owner');

  const report = { ok: true, scenario: 'probability-login-basic-answer-delivery', sourceSha: process.env.GITHUB_SHA ?? null,
    helpDelivered: true, statusDelivered: true, serviceCommandTaskCountBefore: Number(before.n),
    serviceCommandTaskCountAfter: Number(afterCommands.n), loginPassed: true, questionAccepted: true,
    sameUpdateReplayed: true, cpTaskId: task.id, cpGeneration: task.generation, taskTerminalDone: true,
    runnerExecutionCount: executions.length, runnerExecutionSuccess: true, runnerIdPresent: true,
    answerMatchesChallenge: true, telegramDeliverySent: delivery.status === 'sent',
    telegramProviderMessageIdPresent: true, deliveryAttempts: delivery.attempts,
    cpDeliveryRows: Number(cpDeliveryRows.n) };
  await writeFile('sandbox-probability-agent-e2e-evidence.json', `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(report));
}

main().catch(error => {
  const safe = /^[a-z0-9_:.\-]+$/i.test(error.message) ? error.message : 'probability_agent_e2e_failed';
  console.error(JSON.stringify({ ok: false, reasonCode: safe }));
  process.exitCode = 1;
});
