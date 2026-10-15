import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ensureSandboxCpRevision } from '../tools/ensure-sandbox3-cp-revision.mjs';

const sha = 'a'.repeat(40);
const other = 'b'.repeat(40);
const health = buildSha => Response.json({ service: 'trained-assist-control-plane', check: 'liveness', status: 'healthy', buildSha });
function fixture({ alreadyCurrent = false, failed = false, wrongRunSha = false, staleAfterDeploy = false } = {}) {
  const calls = [];
  let dispatched = false;
  const fetcher = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.includes('/healthz')) {
      expect(init.headers?.authorization).toBeUndefined();
      return health(alreadyCurrent || dispatched && !staleAfterDeploy ? sha : other);
    }
    expect(init.headers.authorization).toBe('Bearer test-token');
    if (url.endsWith('/dispatches')) {
      expect(JSON.parse(init.body)).toEqual({ ref: 'main', inputs: { deploy_sandbox3: true } });
      dispatched = true;
      return new Response(null, { status: 204 });
    }
    const run = { id: 42, created_at: '2026-10-15T00:00:00Z', head_branch: 'main', head_sha: wrongRunSha ? other : sha,
      status: 'completed', conclusion: failed ? 'failure' : 'success' };
    return Response.json(url.includes('/runs?') ? { workflow_runs: [run] } : run);
  };
  return { calls, options: { expectedSha: sha, token: 'test-token', fetcher, sleep: async () => {}, maxPolls: 2,
    now: () => Date.parse('2026-10-15T00:00:00Z') } };
}

it('keeps an already-current sandbox intact without dispatching', async () => {
  const { options, calls } = fixture({ alreadyCurrent: true });
  expect(await ensureSandboxCpRevision(options)).toEqual({ expectedSha: sha, matched: true, deployed: false });
  expect(calls).toHaveLength(1);
});
it('deploys through the owner workflow and requires exact live SHA after success', async () => {
  const { options } = fixture();
  expect(await ensureSandboxCpRevision(options)).toEqual({ expectedSha: sha, matched: true, deployed: true, runId: 42 });
});
it.each([
  [{ failed: true }, 'sandbox_cp_deployment_failed'],
  [{ wrongRunSha: true }, 'sandbox_cp_main_changed_before_deployment'],
  [{ staleAfterDeploy: true }, 'sandbox_cp_deployment_or_revision_timeout'],
])('blocks tests on bad deployment evidence %j', async (input, reason) => {
  await expect(ensureSandboxCpRevision(fixture(input).options)).rejects.toThrow(reason);
});
it('refuses missing revision or authority before a network operation', async () => {
  await expect(ensureSandboxCpRevision({ expectedSha: 'main', token: 'test' })).rejects.toThrow('sandbox_cp_revision_config_invalid');
});

it('holds the sandbox lock, cleans state before revision preparation and verifies before enabling scenarios', () => {
  const workflow = readFileSync(new URL('../.github/workflows/sandbox3-worker-e2e.yml', import.meta.url), 'utf8');
  expect(workflow).toContain('group: trained-assist-sandbox3-worker-e2e');
  const reset = workflow.indexOf('- name: Reset CP and both Telegram intake buffers before tests');
  const prepare = workflow.indexOf('- name: Bring sandbox Control Plane to the pinned reviewed revision');
  const verify = workflow.indexOf('- name: Require exact CP revision and lane contract before enabling tests');
  const enable = workflow.indexOf('- name: Enable sandbox3 ingress and delivery after clean preflight');
  const boundary = workflow.indexOf('- name: Recheck CP revision at scenario boundary');
  const scenario = workflow.indexOf('- name: Test real Worker help, status and anonymous-login prompt');
  expect(reset).toBeGreaterThan(-1);
  expect(prepare).toBeGreaterThan(reset);
  expect(verify).toBeGreaterThan(prepare);
  expect(enable).toBeGreaterThan(verify);
  expect(boundary).toBeGreaterThan(enable);
  expect(scenario).toBeGreaterThan(boundary);
  expect(workflow).toContain('EXPECTED_CP_SHA: ${{ steps.cp-revision.outputs.sha }}');
});
