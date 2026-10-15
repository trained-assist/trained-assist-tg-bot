import { pathToFileURL } from 'node:url';

const repository = 'trained-assist/trained-assist-control-plane';
const workflow = 'deploy-sandbox3.yml';
const healthUrl = 'https://trained-assist-cp-sandbox3.skillset-apply.workers.dev/healthz';

export async function ensureSandboxCpRevision({ expectedSha, token, fetcher = fetch,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), maxPolls = 40,
  now = Date.now } = {}) {
  if (!/^[a-f0-9]{40}$/.test(expectedSha ?? '') || !token) throw new Error('sandbox_cp_revision_config_invalid');
  const health = async () => {
    const response = await fetcher(healthUrl, { signal: AbortSignal.timeout(10000), redirect: 'error' });
    const value = await response.json();
    return response.ok && value.service === 'trained-assist-control-plane' && value.check === 'liveness'
      && value.status === 'healthy' && value.buildSha === expectedSha;
  };
  if (await health().catch(() => false)) return { expectedSha, matched: true, deployed: false };
  const api = async (path, body) => {
    const response = await fetcher(`https://api.github.com/repos/${repository}${path}`, {
      method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(15000), redirect: 'error',
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json',
        'content-type': 'application/json', 'user-agent': 'trained-assist-sandbox-revision-gate' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`sandbox_cp_deployment_api_http_${response.status}`);
    return response.status === 204 ? null : response.json();
  };
  const requestedAt = now() - 5000;
  await api(`/actions/workflows/${workflow}/dispatches`, { ref: 'main', inputs: { deploy_sandbox3: true } });
  let runId = null;
  for (let attempt = 0; attempt < maxPolls; attempt++) {
    if (!runId) {
      const page = await api(`/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=10`);
      const run = page.workflow_runs?.find(item => Date.parse(item.created_at) >= requestedAt && item.head_branch === 'main');
      if (run) {
        if (run.head_sha !== expectedSha) throw new Error('sandbox_cp_main_changed_before_deployment');
        runId = run.id;
      }
    }
    if (runId) {
      const run = await api(`/actions/runs/${runId}`);
      if (run.head_sha !== expectedSha) throw new Error('sandbox_cp_deployment_revision_mismatch');
      if (run.status === 'completed') {
        if (run.conclusion !== 'success') throw new Error('sandbox_cp_deployment_failed');
        if (await health().catch(() => false)) return { expectedSha, matched: true, deployed: true, runId };
      }
    }
    if (attempt + 1 < maxPolls) await sleep(15000);
  }
  throw new Error('sandbox_cp_deployment_or_revision_timeout');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  ensureSandboxCpRevision({ expectedSha: process.env.EXPECTED_CP_SHA, token: process.env.GH_TOKEN })
    .then(result => console.log(JSON.stringify({ component: 'control-plane', ...result })))
    .catch(error => { console.error(JSON.stringify({ outcome: 'BLOCKED', reasonCode:
      /^sandbox_cp_[a-z0-9_]+$/.test(error.message) ? error.message : 'sandbox_cp_revision_gate_failed' })); process.exitCode = 1; });
}
