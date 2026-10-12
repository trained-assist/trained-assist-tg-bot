#!/usr/bin/env node
import { randomUUID } from 'node:crypto';

const API = 'https://api.github.com';
const REPOSITORY = 'trained-assist/trained-assist-control-plane';
const WORKFLOW = 'cleanup-telegram-ux-sandbox.yml';
const RUN_TITLE_PREFIX = 'Telegram UX sandbox cleanup ';
const MAX_WAIT_MS = 6 * 60_000;

function required(value, code) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(code);
  return value.trim();
}

export async function dispatchCpSandboxCleanup({
  token,
  runnerTaskIds = '',
  fetchImpl = fetch,
  sleepImpl = ms => new Promise(resolve => setTimeout(resolve, ms)),
  nowImpl = Date.now,
  requestId = randomUUID(),
}) {
  token = required(token, 'cleanup_github_token_missing');
  if (typeof runnerTaskIds !== 'string' || runnerTaskIds.length > 3000) throw new Error('cleanup_task_ids_invalid');
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new Error('cleanup_request_id_invalid');
  const headers = { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28', 'content-type': 'application/json' };
  const request = async (url, init = {}) => {
    let response;
    try { response = await fetchImpl(url, { ...init, headers: { ...headers, ...init.headers }, signal: AbortSignal.timeout(20_000) }); }
    catch { throw new Error('cleanup_github_request_failed'); }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`cleanup_github_http_${response.status}`);
    return body;
  };

  const workflow = await request(`${API}/repos/${REPOSITORY}/actions/workflows/${WORKFLOW}`);
  if (!Number.isSafeInteger(workflow.id)) throw new Error('cleanup_workflow_not_found');
  const title = `${RUN_TITLE_PREFIX}${requestId}`;
  const startedAt = nowImpl();
  const runsUrl = `${API}/repos/${REPOSITORY}/actions/workflows/${workflow.id}/runs?event=workflow_dispatch&per_page=100`;
  const existing = await request(runsUrl);
  const priorIds = new Set((existing.workflow_runs ?? []).map(run => run.id));

  const dispatchResponse = await fetchImpl(`${API}/repos/${REPOSITORY}/actions/workflows/${workflow.id}/dispatches`, {
    method: 'POST', headers, body: JSON.stringify({ ref: 'main', inputs: { request_id: requestId, runner_task_ids: runnerTaskIds } }),
    signal: AbortSignal.timeout(20_000),
  }).catch(() => { throw new Error('cleanup_dispatch_failed'); });
  if (dispatchResponse.status !== 204) throw new Error(`cleanup_dispatch_http_${dispatchResponse.status}`);

  const deadline = startedAt + MAX_WAIT_MS;
  let run;
  while (nowImpl() < deadline) {
    const listing = await request(runsUrl);
    run = (listing.workflow_runs ?? []).find(item => !priorIds.has(item.id)
      && item.event === 'workflow_dispatch' && item.head_branch === 'main' && item.display_title === title);
    if (run) break;
    await sleepImpl(2_000);
  }
  if (!run) throw new Error('cleanup_run_not_found');

  while (nowImpl() < deadline) {
    const current = await request(`${API}/repos/${REPOSITORY}/actions/runs/${run.id}`);
    if (current.status === 'completed') {
      if (current.conclusion !== 'success') throw new Error(`cleanup_workflow_${current.conclusion ?? 'failed'}`);
      return { requestId, runId: current.id, url: current.html_url, conclusion: current.conclusion };
    }
    await sleepImpl(5_000);
  }
  throw new Error('cleanup_workflow_timeout');
}

async function main() {
  const result = await dispatchCpSandboxCleanup({ token: process.env.GH_TOKEN,
    runnerTaskIds: process.env.RUNNER_TASK_IDS ?? '' });
  console.log(JSON.stringify({ lane: 'telegram-ux-v1', ...result }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    const message = error instanceof Error ? error.message : '';
    const reasonCode = /^[a-z0-9_-]+$/i.test(message) ? message : 'cleanup_dispatch_failed';
    console.error(JSON.stringify({ lane: 'telegram-ux-v1', outcome: 'cleanup_failed', reasonCode }));
    process.exitCode = 1;
  });
}
