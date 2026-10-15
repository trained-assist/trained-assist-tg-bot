import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Ship reviewed code and its managed secrets in a single Worker deployment.
// Separate `secret put` mutates/deploys old code and fails when an undeployed
// version exists. Wrangler preserves all other existing secret bindings.
export function deployMainWorker({ env = process.env, invoke = spawnSync } = {}) {
  if (!/^[a-f0-9]{40}$/.test(env.BUILD_SHA ?? '')) throw new Error('invalid_build_sha');
  const secrets = {};
  for (const name of ['ADMIN_GROUP_ID', 'CONTROL_PLANE_PRINCIPAL_SIGNATURE', 'CONTROL_PLANE_SECRET']) {
    const valid = name === 'ADMIN_GROUP_ID' ? /^-?\d+$/.test(env[name] ?? '') : /^[a-f0-9]{64}$/.test(env[name] ?? '');
    if (!valid) throw new Error(`missing_or_invalid_deployment_secret:${name}`);
    secrets[name] = env[name];
  }
  const directory = mkdtempSync(join(tmpdir(), 'ta-main-worker-secrets-'));
  try {
    const file = join(directory, 'secrets.json');
    writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
    const result = invoke('npx', ['wrangler', 'deploy', '--env=', '--name', 'trained-assist-tg-bot',
      '--secrets-file', file, '--var', `BUILD_SHA:${env.BUILD_SHA}`], { env, stdio: 'inherit' });
    return result.status ?? 1;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = deployMainWorker(); }
  catch { console.error('main_worker_deployment_failed'); process.exitCode = 1; }
}
