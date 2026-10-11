#!/usr/bin/env node
import assert from 'node:assert/strict';
import { stopReplyConfirmsRequest } from './sandbox3-stop-confirmation.mjs';

const ACCOUNT_ID = 'd740a05e9442c1d0feacae2dfc673e93';
const DATABASE_ID = '1e1b8108-9186-43e2-8e50-436598233165';
const PROFILE_ID = 'integration-sandbox3-v1';
const RECOVERY_USERNAME = 'sandbox3_recovery';
const TG_ORIGIN = 'https://trained-assist-tg-sandbox3.skillset-apply.workers.dev';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_required`);
  return value;
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

async function sendUpdate(chatId, userId, text, updateId, extra = {}) {
  const response = await fetch(`${TG_ORIGIN}/operator/test-update`, {
    method: 'POST',
    headers: { authorization: `Bearer ${required('TG_SANDBOX3_OPERATOR_TOKEN')}`, 'content-type': 'application/json' },
    body: JSON.stringify({ target: 'sandbox3', type: 'message', chatId, userId,
      delivery: 'telegram', updateId, text, ...extra }),
    signal: AbortSignal.timeout(180_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`sandbox3_worker_${response.status}_${payload.error ?? 'failed'}`);
  return payload;
}

function passwordFrom(payload) {
  const messages = payload.transcript?.filter(item => item.kind === 'sendMessage') ?? [];
  const text = messages.map(item => String(item.text ?? '')).join('\n');
  return /Пароль:\s*<code>([^<]+)<\/code>/i.exec(text)?.[1] ?? null;
}

async function loginRecoveryProfile(chatId, userId, updateId) {
  let credential = await sendUpdate(chatId, userId, `/pass_reset ${RECOVERY_USERNAME}`, updateId++,
    { delivery: 'capture', admin: true });
  let password = passwordFrom(credential);
  if (!password) {
    credential = await sendUpdate(chatId, userId, `/adduser ${RECOVERY_USERNAME} Sandbox3 Recovery`, updateId++,
      { delivery: 'capture', admin: true });
    password = passwordFrom(credential);
  }
  assert(password, 'sandbox3_recovery_profile_password_missing');
  const login = await sendUpdate(chatId, userId, `/login ${RECOVERY_USERNAME} ${password}`, updateId++);
  const loginMessages = login.transcript?.filter(item => item.kind === 'sendMessage') ?? [];
  assert(loginMessages.some(item => item.telegramOk === true && Number.isSafeInteger(item.messageId)
    && item.messageId > 0), 'sandbox3_recovery_login_reply_not_delivered');
  assert.equal(login.admission?.authenticated, true, 'sandbox3_recovery_profile_login_failed');
  return updateId;
}

async function sendStop(chatId, userId, updateId) {
  const payload = await sendUpdate(chatId, userId, '/stop', updateId);
  const messages = payload.transcript?.filter(item => item.kind === 'sendMessage') ?? [];
  assert(messages.some(item => item.telegramOk === true && Number.isSafeInteger(item.messageId) && item.messageId > 0),
    'sandbox3_stop_reply_not_delivered');
  const text = messages.map(item => String(item.text ?? '')).join('\n');
  return stopReplyConfirmsRequest(text);
}

async function reconcileTerminalRuns(chatId) {
  const headers = { authorization: `Bearer ${required('TG_SANDBOX3_OPERATOR_TOKEN')}`, 'content-type': 'application/json' };
  const inspect = await fetch(`${TG_ORIGIN}/operator/stop-window`, { method: 'POST', headers,
    body: JSON.stringify({ mode: 'inspect', profileId: PROFILE_ID, chatId, threadId: null }),
    signal: AbortSignal.timeout(30_000) });
  const inspected = await inspect.json().catch(() => ({}));
  if (!inspect.ok || typeof inspected.snapshot?.windowId !== 'string')
    throw new Error('sandbox3_stop_window_inspect_failed');
  const windowId = inspected.snapshot.windowId;
  const response = await fetch(`${TG_ORIGIN}/operator/stop-window`, { method: 'POST', headers,
    body: JSON.stringify({ mode: 'reconcile', profileId: PROFILE_ID, chatId, threadId: null,
      windowId, confirmWindowId: windowId }), signal: AbortSignal.timeout(90_000) });
  const outcome = await response.json().catch(() => ({}));
  assert(response.ok && outcome.released === true && outcome.recoveryOutcome === 'reconciled_cancelled',
    'sandbox3_terminal_run_reconciliation_refused');
}

async function main() {
  assert.equal(process.env.TG_SANDBOX_TARGET, 'sandbox3', 'sandbox3_target_required');
  assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, ACCOUNT_ID, 'sandbox3_account_mismatch');
  const chatId = Number(required('TG_SANDBOX_E2E_CHAT_ID'));
  const userId = Number(required('TG_SANDBOX_E2E_USER_ID'));
  assert.equal(chatId, 1714048, 'sandbox3_chat_mismatch');
  assert.equal(userId, 1714048, 'sandbox3_user_mismatch');

  const activeTasks = await d1(`SELECT id, status, generation FROM durable_tasks
    WHERE profile_id = ? AND status NOT IN ('done', 'failed', 'cancelled') ORDER BY created_at DESC LIMIT 5`, [PROFILE_ID]);
  if (activeTasks.length === 0) {
    console.log(JSON.stringify({ ok: true, activeTaskCount: 0, stopRequired: false }));
    return;
  }
  assert.equal(activeTasks.length, 1, 'sandbox3_stop_recovery_unexpected_active_task_count');
  const task = activeTasks[0];
  const updateId = await loginRecoveryProfile(chatId, userId, Date.now());
  const stopConfirmed = await sendStop(chatId, userId, updateId);
  if (!stopConfirmed) await reconcileTerminalRuns(chatId);

  const deadline = Date.now() + 120_000;
  let observed = null;
  while (Date.now() < deadline) {
    const [current] = await d1('SELECT id, status, generation FROM durable_tasks WHERE id = ?', [task.id]);
    const [execution] = await d1('SELECT status FROM executions WHERE task_id = ? ORDER BY started_at DESC LIMIT 1', [task.id]);
    observed = { taskStatus: current?.status ?? 'missing', generation: current?.generation ?? null,
      executionStatus: execution?.status ?? 'missing' };
    if (['done', 'failed', 'cancelled'].includes(observed.taskStatus)
        && !['running', 'unknown', 'waiting'].includes(observed.executionStatus)) {
      console.log(JSON.stringify({ ok: true, stopRequired: true, terminal: observed }));
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
  console.error(JSON.stringify({ ok: false, reasonCode: 'sandbox3_stop_recovery_timeout', terminal: observed }));
  throw new Error('sandbox3_stop_recovery_timeout');
}

main().catch(error => {
  const message = error instanceof Error ? error.message : '';
  const reasonCode = /^[a-z0-9_:.-]+$/.test(message) ? message : 'sandbox3_stop_recovery_failed';
  console.error(JSON.stringify({ ok: false, reasonCode }));
  process.exitCode = 1;
});
