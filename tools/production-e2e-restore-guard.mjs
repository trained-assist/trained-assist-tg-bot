#!/usr/bin/env node
const url = 'https://trained-assist-tg-sandbox3.skillset-apply.workers.dev/operator/test-evidence';
const token = process.env.TG_SANDBOX3_OPERATOR_TOKEN?.trim();
if (!token) throw new Error('operator_token_required');
const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
const evidence = await response.json().catch(() => ({}));
if (!response.ok || evidence.profileId !== 'production-e2e-telegram-v1') {
  console.log(JSON.stringify({ safeToRestore: false, reasonCode: 'production_lane_evidence_unavailable' }));
  process.exitCode = 1;
} else {
  const buffer = evidence.buffer ?? {};
  const active = buffer.busy === true || buffer.pendingCount !== 0 || buffer.launching !== 0 ||
    buffer.unresolvedLaunchCount !== 0 || buffer.busyRequestCount !== 0;
  const nonterminal = (evidence.tasks ?? []).some(task => !['done', 'failed', 'cancelled'].includes(task.status));
  const safeToRestore = !active && !nonterminal;
  console.log(JSON.stringify({ safeToRestore, reasonCode: safeToRestore ? 'terminal_and_idle' : 'production_task_or_buffer_not_terminal',
    active, nonterminal, taskCount: (evidence.tasks ?? []).length }));
  if (!safeToRestore) process.exitCode = 1;
}
