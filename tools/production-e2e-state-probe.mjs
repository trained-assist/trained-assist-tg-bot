#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';

const worker = 'https://trained-assist-tg-sandbox3.skillset-apply.workers.dev';
const token = process.env.TG_SANDBOX3_OPERATOR_TOKEN?.trim();
const signature = process.env.PRODUCTION_E2E_SIGNATURE?.trim();
if (!token || !signature) throw new Error('probe_credentials_required');

const response = await fetch(`${worker}/operator/test-evidence`, {
  headers: { authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(20_000),
});
const evidence = await response.json().catch(() => ({}));
if (!response.ok || evidence.profileId !== 'production-e2e-telegram-v1') {
  throw new Error('production_e2e_readonly_probe_unavailable');
}

const cpTasks = await Promise.all((evidence.tasks ?? []).map(async task => {
  const statusResponse = await fetch('https://trained-assist-cp-production.skillset-apply.workers.dev/status', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-principal': 'production-e2e-telegram-v1',
      'x-principal-sig': signature },
    body: JSON.stringify({ taskId: task.userTaskId }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!statusResponse.ok) return { httpStatus: statusResponse.status };
  const status = await statusResponse.json().catch(() => ({}));
  const engine = status.engine && typeof status.engine === 'object' ? status.engine : {};
  const row = status.taskStore && typeof status.taskStore === 'object' ? status.taskStore : {};
  const engineError = String(engine.error ?? '').toLowerCase();
  const workflowErrorCode = !engineError ? null
    : /not found|no such instance/.test(engineError) ? 'workflow_instance_missing'
      : /timeout|timed out/.test(engineError) ? 'workflow_status_timeout'
        : 'workflow_status_unavailable';
  return {
    taskStatus: typeof row.status === 'string' ? row.status : null,
    taskStage: typeof row.stage === 'string' ? row.stage : null,
    generation: Number.isSafeInteger(row.generation) ? row.generation : null,
    workflowStatus: typeof engine.status === 'string' && /^[a-z_-]{1,40}$/i.test(engine.status)
      ? engine.status.toLowerCase() : null,
    workflowStatusType: engine.status === null ? 'null' : typeof engine.status,
    workflowEngineKeys: Object.keys(engine).filter(key => /^[a-zA-Z0-9_-]{1,40}$/.test(key)),
    workflowErrorCode,
    workflowErrorName: typeof engine.error?.name === 'string' && /^[a-z_-]{1,40}$/i.test(engine.error.name)
      ? engine.error.name.toLowerCase() : null,
    runCount: Array.isArray(status.runs) ? status.runs.length : 0,
    runs: (status.runs ?? []).map(run => ({
      status: typeof run.status === 'string' ? run.status : null,
      hasSessionId: typeof run.session_id === 'string' && !!run.session_id,
      hasStartedAt: Number.isSafeInteger(run.started_at),
      hasFinishedAt: Number.isSafeInteger(run.finished_at),
    })),
  };
}));

const summary = {
  ok: true,
  mode: 'read-only',
  profileId: evidence.profileId,
  readiness: evidence.readiness ?? null,
  buffer: evidence.buffer ? {
    pendingCount: evidence.buffer.pendingCount ?? null,
    busy: evidence.buffer.busy === true,
    launching: evidence.buffer.launching ?? 0,
    unresolvedLaunchCount: evidence.buffer.unresolvedLaunchCount ?? 0,
    busyRequestCount: evidence.buffer.busyRequestCount ?? 0,
    alarmAt: Number.isSafeInteger(evidence.buffer.alarmAt) ? evidence.buffer.alarmAt : null,
    stranded: evidence.buffer.stranded === true,
  } : null,
  tasks: (evidence.tasks ?? []).map(task => ({
    userTaskId: task.userTaskId,
    status: task.status,
    acceptedAt: Number.isFinite(Number(task.acceptedAt)) ? Number(task.acceptedAt) : null,
    routingOutcome: task.routingOutcome ? {
      known: task.routingOutcome.known === true,
      degraded: task.routingOutcome.degraded === true,
      routeReasonCode: task.routingOutcome.routeReasonCode ?? null,
      continuationRequested: task.routingOutcome.continuationRequested === true,
      continuationIssued: task.routingOutcome.continuationIssued === true,
      continuationRefusal: task.routingOutcome.continuationRefusal ?? null,
    } : null,
    resultPresent: task.resultPresent === true,
    answerPresent: task.answerPresent === true,
    runs: (task.runs ?? []).map(run => ({
      status: run.status,
      hasSessionId: run.hasSessionId === true,
      hasStartedAt: run.hasStartedAt === true,
      hasFinishedAt: run.hasFinishedAt === true,
    })),
    historyTypes: (task.historyTypes ?? []).filter(type => typeof type === 'string' && /^[a-z0-9_-]{1,80}$/i.test(type)),
    cpStatus: cpTasks[(evidence.tasks ?? []).indexOf(task)],
  })),
  answerTextLogged: false,
  promptTextLogged: false,
  mutationPerformed: false,
};

await writeFile('production-e2e-telegram-evidence.json', `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(summary));
