#!/usr/bin/env node
import assert from 'node:assert/strict';

const ACCOUNT_ID = 'd740a05e9442c1d0feacae2dfc673e93';
const DATABASE_ID = '01d17f46-63e2-46bc-947d-9eda3e0bb697';
const TG_ORIGIN = 'https://trained-assist-tg-ux-sandbox.skillset-apply.workers.dev';
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
  const response = await fetch(`${TG_ORIGIN}${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${required('TG_SANDBOX_CLEANUP_TOKEN')}`, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`tg_sandbox_operator_${path.replaceAll('/', '_')}_${response.status}:${payload.error ?? 'failed'}`);
  return payload;
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

function assertNoActiveCpState(counts) {
  for (const name of ['nonterminal_tasks', 'active_executions', 'active_deliveries', 'awaiting_inputs', 'pending_inputs', 'pending_schedule_occurrences']) {
    assert.equal(Number(counts[name]), 0, `refusing reset: ${name}=${counts[name]}`);
  }
}

function assertEmpty(cp, tg) {
  for (const name of CP_STATE_TABLES) assert.equal(Number(cp[name] ?? 0), 0, `CP sandbox not empty: ${name}=${cp[name]}`);
  for (const name of ['sessionAndRetryKeys', 'sandboxUserKeys', 'intakeBuffers', 'durableObjectKeys', 'acceptOnlyKeys']) {
    assert.equal(Number(tg[name] ?? 0), 0, `TG sandbox not empty: ${name}=${tg[name]}`);
  }
  assert.equal(tg.active, false);
}

async function inspect() {
  const health = await fetch(`${TG_ORIGIN}/health`, { signal: AbortSignal.timeout(10_000) });
  const healthBody = await health.json().catch(() => ({}));
  assert.equal(health.ok, true, 'TG sandbox worker is not live');
  assert.equal(healthBody.mode, 'existing-ux-control-plane');
  const tableNames = new Set((await d1("SELECT name FROM sqlite_master WHERE type='table'")).map(row => row.name));
  for (const table of CP_STATE_TABLES) assert(tableNames.has(table), `CP state table missing: ${table}`);
  const [cpCounts] = await d1(`SELECT ${CP_STATE_TABLES.map(name => `(SELECT COUNT(*) FROM "${name}") AS "${name}"`).join(', ')}`);
  const tg = await workerRequest('/operator/reset-sandbox-state', { target: 'sandbox', mode: 'inspect' });
  return { cp: cpCounts, tg };
}

async function reset() {
  const state = await inspect();
  assertNoActiveCpState(await cpInventory());
  if (state.tg.active !== false) throw new Error('refusing_reset_active_tg_buffer');
  // Clear the TG alarms/buffers first while its operator lock blocks fresh
  // webhooks. CP has already passed the all-profile no-active-run preflight.
  const tgClear = await workerRequest('/operator/reset-sandbox-state', {
    target: 'sandbox', mode: 'clear', confirm: 'CLEAR_ALL_SANDBOX_STATE',
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
  const verified = await inspect();
  assertEmpty(verified.cp, verified.tg);
  console.log(JSON.stringify({ ok: true, target: 'sandbox', cpRuntimeRowsDeleted: state.cp,
    tgStateDeleted: tgClear, cpEmpty: true, tgEmpty: true }));
}

async function testBuffers() {
  const first = await workerRequest('/operator/test-buffer-message', { target: 'sandbox', text: 'sandbox-buffer-test first part' });
  assert.deepEqual(first.buffer, { pendingCount: 1, hasText: true, busy: false, stranded: false });
  const second = await workerRequest('/operator/test-buffer-message', { target: 'sandbox', text: 'sandbox-buffer-test second part', resetAfter: true });
  assert.deepEqual(second.buffer, { pendingCount: 2, hasText: true, busy: false, stranded: false });
  assert.equal(second.clearedAfterRead, true);
  console.log(JSON.stringify({ ok: true, scenario: 'fresh-message-buffer-aggregation',
    firstPendingCount: first.buffer.pendingCount, secondPendingCount: second.buffer.pendingCount }));
}

const mode = process.argv[2];
if (mode === 'inspect') {
  const state = await inspect();
  assertNoActiveCpState(await cpInventory());
  assertEmpty(state.cp, state.tg);
  console.log(JSON.stringify({ ok: true, cpEmpty: true, tgEmpty: true }));
} else if (mode === 'reset') await reset();
else if (mode === 'test-buffers') await testBuffers();
else throw new Error('usage: node tools/sandbox-buffer-cycle.mjs inspect|reset|test-buffers');
