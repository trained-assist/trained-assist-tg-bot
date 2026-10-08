import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const PREVIEW_PREFIX = 'ta-tg-staging-';
const PREVIEW_NAME = /^ta-tg-staging-[a-f0-9]{12}$/;
const DEFAULT_BRANCH = 'main';
const DAY_MS = 24 * 60 * 60 * 1000;

function workerNameForBranch(branch) {
  if (typeof branch !== 'string' || !branch) return null;
  const suffix = createHash('sha256').update(branch).digest('hex').slice(0, 12);
  const name = `${PREVIEW_PREFIX}${suffix}`;
  if (!PREVIEW_NAME.test(name)) throw new Error('Invalid preview Worker name');
  return name;
}

export function previewWorkerForBranch(branch) {
  if (branch === DEFAULT_BRANCH) return null;
  return workerNameForBranch(branch);
}

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function jsonRequest(url, { token, method = 'GET', fetchImpl }) {
  const response = await fetchImpl(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  let data = null;
  if (response.status !== 204 && response.status !== 404) {
    try { data = await response.json(); } catch { /* handled below */ }
  }
  if (response.status === 404) return { missing: true, data: null };
  if (!response.ok || data?.success === false) {
    const detail = data?.errors?.map(error => `${error.code}: ${error.message}`).join('; ')
      || `HTTP ${response.status}`;
    throw new Error(`API ${method} ${new URL(url).pathname} failed: ${detail}`);
  }
  return { missing: false, data };
}

async function deletePreview(branch, context) {
  const worker = previewWorkerForBranch(branch);
  if (!worker) return { status: 'protected', branch };
  const result = await jsonRequest(`${context.cloudflareBase}/${encodeURIComponent(worker)}`, {
    token: context.cloudflareToken,
    method: 'DELETE',
    fetchImpl: context.fetchImpl,
  });
  return { status: result.missing ? 'already-absent' : 'deleted', branch, worker };
}

async function githubPages(path, context) {
  const items = [];
  for (let page = 1; ; page++) {
    const url = new URL(`https://api.github.com/repos/${context.repository}/${path}`);
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));
    const { data } = await jsonRequest(url, { token: context.githubToken, fetchImpl: context.fetchImpl });
    if (!Array.isArray(data)) throw new Error(`GitHub API returned an invalid list for ${path}`);
    items.push(...data);
    if (data.length < 100) return items;
  }
}

async function cloudflarePages(context) {
  const items = [];
  for (let page = 1; ; page++) {
    const url = new URL(context.cloudflareBase);
    url.searchParams.set('per_page', '1000');
    url.searchParams.set('page', String(page));
    const { data } = await jsonRequest(url, { token: context.cloudflareToken, fetchImpl: context.fetchImpl });
    if (!Array.isArray(data?.result)) throw new Error('Cloudflare API returned an invalid Worker list');
    items.push(...data.result);
    const perPage = data.result_info?.per_page ?? 1000;
    const totalPages = data.result_info?.total_pages
      ?? Math.ceil((data.result_info?.total_count ?? data.result.length) / perPage);
    if (page >= totalPages) return items;
  }
}

async function hasOpenPullRequest(branch, context) {
  const [owner] = context.repository.split('/');
  const url = new URL(`https://api.github.com/repos/${context.repository}/pulls`);
  url.searchParams.set('state', 'open');
  url.searchParams.set('head', `${owner}:${branch}`);
  url.searchParams.set('per_page', '100');
  const { data } = await jsonRequest(url, { token: context.githubToken, fetchImpl: context.fetchImpl });
  if (!Array.isArray(data)) throw new Error('GitHub API returned an invalid pull request list');
  return data.length > 0;
}

export async function handleCleanupEvent(event, context) {
  const repository = event.repository?.full_name;
  if (!repository || repository !== context.repository) return [{ status: 'skipped', reason: 'repository mismatch' }];

  if (context.eventName === 'pull_request') {
    const branch = event.pull_request?.head?.ref;
    const headRepository = event.pull_request?.head?.repo?.full_name;
    if (!branch || headRepository !== repository) return [{ status: 'skipped', reason: 'fork or missing branch' }];
    if (await hasOpenPullRequest(branch, context)) {
      return [{ status: 'preserved', branch, reason: 'another open pull request uses this branch' }];
    }
    return [await deletePreview(branch, context)];
  }

  if (context.eventName === 'delete') {
    if (event.ref_type !== 'branch' || typeof event.ref !== 'string') return [{ status: 'skipped', reason: 'not a branch deletion' }];
    if (event.ref === DEFAULT_BRANCH) return [{ status: 'protected', branch: event.ref }];
    return [await deletePreview(event.ref, context)];
  }

  if (context.eventName !== 'schedule' && context.eventName !== 'workflow_dispatch') {
    return [{ status: 'skipped', reason: 'unsupported event' }];
  }

  const [branches, openPullRequests] = await Promise.all([
    githubPages('branches', context),
    githubPages('pulls?state=open', context),
  ]);
  const activeWorkers = new Set(branches.map(branch => workerNameForBranch(branch.name)).filter(Boolean));
  for (const pullRequest of openPullRequests) {
    if (pullRequest.head?.repo?.full_name === repository) {
      const worker = workerNameForBranch(pullRequest.head.ref);
      if (worker) activeWorkers.add(worker);
    }
  }
  const workers = await cloudflarePages(context);
  const now = context.now ?? Date.now();
  const dryRun = context.eventName === 'workflow_dispatch'
    && event.inputs?.dry_run !== false && event.inputs?.dry_run !== 'false';
  const outcomes = [];
  for (const item of workers) {
    const worker = item.id;
    if (typeof worker !== 'string' || !PREVIEW_NAME.test(worker)) continue;
    if (activeWorkers.has(worker)) continue;
    const lastModified = Date.parse(item.modified_on || item.created_on || '');
    if (!Number.isFinite(lastModified) || now - lastModified < DAY_MS) continue;
    if (dryRun) {
      outcomes.push({ status: 'would-delete', worker });
      continue;
    }
    const result = await jsonRequest(`${context.cloudflareBase}/${encodeURIComponent(worker)}`, {
      token: context.cloudflareToken,
      method: 'DELETE',
      fetchImpl: context.fetchImpl,
    });
    outcomes.push({ status: result.missing ? 'already-absent' : 'deleted', worker });
  }
  return outcomes;
}

async function main() {
  const eventPath = required(process.env, 'GITHUB_EVENT_PATH');
  const event = JSON.parse(await readFile(eventPath, 'utf8'));
  const repository = required(process.env, 'GITHUB_REPOSITORY');
  const accountId = required(process.env, 'CF_ACCOUNT_ID');
  const context = {
    eventName: required(process.env, 'GITHUB_EVENT_NAME'),
    repository,
    githubToken: required(process.env, 'GITHUB_TOKEN'),
    cloudflareToken: required(process.env, 'CF_API_TOKEN'),
    cloudflareBase: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts`,
    fetchImpl: fetch,
  };
  const outcomes = await handleCleanupEvent(event, context);
  for (const outcome of outcomes) console.log(JSON.stringify(outcome));
  console.log(`Preview cleanup finished: ${outcomes.length} outcome(s).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
