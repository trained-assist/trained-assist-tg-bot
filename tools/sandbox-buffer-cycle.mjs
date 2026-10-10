#!/usr/bin/env node
import assert from 'node:assert/strict';
import { assertSandboxStateEventuallyEmpty } from './sandbox-buffer-assertions.mjs';
import { runSandboxEntryScenario } from './sandbox-entry-smoke-lib.mjs';

const ACCOUNT_ID = 'd740a05e9442c1d0feacae2dfc673e93';
const TARGET = process.env.TG_SANDBOX_TARGET === 'sandbox3' ? 'sandbox3' : 'sandbox';
const DATABASE_ID = TARGET === 'sandbox3' ? '1e1b8108-9186-43e2-8e50-436598233165' : '01d17f46-63e2-46bc-947d-9eda3e0bb697';
const PROFILE_ID = TARGET === 'sandbox3' ? 'integration-sandbox3-v1' : null;
const TG_ORIGIN = TARGET === 'sandbox3'
  ? 'https://trained-assist-tg-sandbox3.skillset-apply.workers.dev'
  : 'https://trained-assist-tg-ux-sandbox.skillset-apply.workers.dev';
const OPERATOR_TOKEN_NAME = TARGET === 'sandbox3' ? 'TG_SANDBOX3_OPERATOR_TOKEN' : 'TG_SANDBOX_CLEANUP_TOKEN';
const CP_STATE_TABLES = [
  'durable_tasks', 'conversations', 'executions', 'task_events', 'task_signals', 'awaiting_inputs',
  'deliveries', 'task_artifacts', 'credential_completions', 'pending_inputs', 'gtd_records', 'gtd_outcomes',
  'gtd_progressions', 'gtd_conditions', 'schedule_occurrences', 'schedules', 'cp_stop_windows',
  'stuck_input_alerts', 'watchdog_health',
];

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_required`);
  return value;
}

async function workerRequest(path, body) {
  const readyDeadline = Date.now() + 60_000;
  while (true) {
    const response = await fetch(`${TG_ORIGIN}${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${required(OPERATOR_TOKEN_NAME)}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
    });
    const payload = await response.json().catch(() => ({}));
    if (response.ok) return payload;
    // A deploy can reach the health edge before its vars reach every Worker
    // isolate. This response is sent before update dispatch, so retry is safe.
    if (path === '/operator/test-update' && response.status === 409
        && payload.error === 'sandbox_test_api_not_ready' && Date.now() < readyDeadline) {
      await new Promise(resolve => setTimeout(resolve, 2_000));
      continue;
    }
    throw new Error(`tg_sandbox_operator_${path.replaceAll('/', '_')}_${response.status}:${payload.error ?? 'failed'}`);
  }
}

async function d1(sql, params = []) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`, {
    method: 'POST', headers: { authorization: `Bearer ${required('CF_API_TOKEN')}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sql, params }), signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success !== true) throw new Error(`cp_sandbox_d1_query_failed:${response.status}`);
  return payload.result?.[0]?.results ?? [];
}

async function cpInventory() {
  const [counts] = await d1(`SELECT
    (SELECT COUNT(*) FROM durable_tasks) AS durable_tasks,
    (SELECT COUNT(*) FROM durable_tasks WHERE status NOT IN ('done','failed','cancelled')) AS nonterminal_tasks,
    (SELECT COUNT(*) FROM executions WHERE status IN ('running','waiting','unknown')) AS active_executions,
    (SELECT COUNT(*) FROM deliveries WHERE status IN ('pending','accepted','unknown')) AS active_deliveries,
    (SELECT COUNT(*) FROM awaiting_inputs) AS awaiting_inputs,
    (SELECT COUNT(*) FROM pending_inputs) AS pending_inputs,
    (SELECT COUNT(*) FROM schedule_occurrences WHERE state IN ('due','failed')) AS pending_schedule_occurrences,
    (SELECT COUNT(*) FROM conversations) AS conversations`);
  return counts;
}

async function assertSandboxScope() {
  if (TARGET !== 'sandbox3') return;
  for (const table of ['durable_tasks', 'conversations', 'schedules', 'gtd_records']) {
    const [foreign] = await d1(`SELECT COUNT(*) AS n FROM "${table}" WHERE profile_id IS NULL OR profile_id != ?`, [PROFILE_ID]);
    assert.equal(Number(foreign.n), 0, `refusing to clear non-sandbox3 ${table}`);
  }
}

function assertNoActiveCpState(counts) {
  for (const name of ['nonterminal_tasks', 'active_executions', 'active_deliveries', 'awaiting_inputs', 'pending_inputs', 'pending_schedule_occurrences']) {
    assert.equal(Number(counts[name]), 0, `refusing reset: ${name}=${counts[name]}`);
  }
}

async function inspect() {
  const health = await fetch(`${TG_ORIGIN}/health`, { signal: AbortSignal.timeout(10_000) });
  const healthBody = await health.json().catch(() => ({}));
  assert.equal(health.ok, true, 'TG sandbox worker is not live');
  assert.equal(healthBody.mode, 'existing-ux-control-plane');
  await assertSandboxScope();
  const tableNames = new Set((await d1("SELECT name FROM sqlite_master WHERE type='table'")).map(row => row.name));
  for (const table of CP_STATE_TABLES) assert(tableNames.has(table), `CP state table missing: ${table}`);
  const [cpCounts] = await d1(`SELECT ${CP_STATE_TABLES.map(name => `(SELECT COUNT(*) FROM "${name}") AS "${name}"`).join(', ')}`);
  const tg = await workerRequest('/operator/reset-sandbox-state', { target: TARGET, mode: 'inspect' });
  return { cp: cpCounts, tg };
}

async function inspectUntilEmpty() {
  return assertSandboxStateEventuallyEmpty(async () => {
    const state = await inspect();
    assertNoActiveCpState(await cpInventory());
    return state;
  }, CP_STATE_TABLES, {
    onRetry: detail => console.log(JSON.stringify({ waitingForSandboxKvVisibility: true, ...detail })),
  });
}

async function reset() {
  const state = await inspect();
  assertNoActiveCpState(await cpInventory());
  if (state.tg.active !== false) throw new Error('refusing_reset_active_tg_buffer');
  // Clear the TG alarms/buffers first while its operator lock blocks fresh
  // webhooks. CP has already passed the all-profile no-active-run preflight.
  const tgClear = await workerRequest('/operator/reset-sandbox-state', {
    target: TARGET, mode: 'clear', confirm: 'CLEAR_ALL_SANDBOX_STATE',
  });
  const statements = [
    // Remove direct and non-cascading task dependants before deleting roots.
    'DELETE FROM credential_completions',
    'DELETE FROM deliveries',
    'DELETE FROM task_artifacts',
    'DELETE FROM executions',
    'DELETE FROM task_events',
    'DELETE FROM task_signals',
    'DELETE FROM awaiting_inputs',
    'DELETE FROM pending_inputs',
    'DELETE FROM gtd_conditions',
    'DELETE FROM gtd_progressions',
    'DELETE FROM gtd_outcomes',
    'DELETE FROM gtd_records',
    'DELETE FROM durable_tasks',
    'DELETE FROM conversations',
    'DELETE FROM schedule_occurrences',
    'DELETE FROM schedules',
    'DELETE FROM cp_stop_windows',
    'DELETE FROM stuck_input_alerts',
    'DELETE FROM watchdog_health',
  ];
  for (const sql of statements) await d1(sql);
  await inspectUntilEmpty();
  console.log(JSON.stringify({ ok: true, target: TARGET, cpRuntimeRowsDeleted: state.cp,
    tgStateDeleted: tgClear, cpEmpty: true, tgEmpty: true }));
}

async function testBuffers() {
  const first = await workerRequest('/operator/test-buffer-message', { target: TARGET, text: 'sandbox-buffer-test first part' });
  assert.deepEqual(first.buffer, { pendingCount: 1, hasText: true, busy: false, stranded: false });
  const second = await workerRequest('/operator/test-buffer-message', { target: TARGET, text: 'sandbox-buffer-test second part', resetAfter: true });
  assert.deepEqual(second.buffer, { pendingCount: 2, hasText: true, busy: false, stranded: false });
  assert.equal(second.clearedAfterRead, true);
  console.log(JSON.stringify({ ok: true, scenario: 'fresh-message-buffer-aggregation',
    firstPendingCount: first.buffer.pendingCount, secondPendingCount: second.buffer.pendingCount }));
}

async function testUserEntry() {
  const identity = TARGET === 'sandbox3' ? {
    target: TARGET, chatId: Number(required('TG_SANDBOX_E2E_CHAT_ID')),
    userId: Number(required('TG_SANDBOX_E2E_USER_ID')),
    delivery: process.env.TG_SANDBOX_E2E_DELIVERY === 'telegram' ? 'telegram' : 'capture',
  } : { target: TARGET };
  if (TARGET === 'sandbox3' && (!Number.isSafeInteger(identity.chatId) || identity.chatId === 0
      || !Number.isSafeInteger(identity.userId) || identity.userId <= 0)) throw new Error('sandbox3_test_identity_invalid');
  const report = await runSandboxEntryScenario((path, body) => workerRequest(path, body), identity);
  console.log(JSON.stringify(report));
}

const mode = process.argv[2];
if (mode === 'inspect') {
  await inspectUntilEmpty();
  console.log(JSON.stringify({ ok: true, cpEmpty: true, tgEmpty: true }));
} else if (mode === 'reset') await reset();
else if (mode === 'test-buffers') await testBuffers();
else if (mode === 'test-user-entry') await testUserEntry();
else throw new Error('usage: node tools/sandbox-buffer-cycle.mjs inspect|reset|test-buffers|test-user-entry');
