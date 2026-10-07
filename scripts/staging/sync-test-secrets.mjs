import { spawnSync } from 'node:child_process';

const agentSecret = process.env.TG_STAGING_AGENT_SECRET;
const webhookSecret = process.env.TG_STAGING_WEBHOOK_SECRET;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!agentSecret || !webhookSecret || !accountId) throw new Error('Missing staging bindings');
const wrangler = new URL('../../node_modules/.bin/wrangler', import.meta.url).pathname;
const identity = spawnSync(wrangler, ['whoami'], { encoding: 'utf8', env: process.env });
const identityText = `${identity.stdout || ''}\n${identity.stderr || ''}`;
if (identity.status !== 0 || !identityText.includes('typeformowner@gmail.com') || !identityText.includes(accountId)) {
  throw new Error('Cloudflare authentication does not match the trained-assist staging account');
}
function sync(args, values) {
  const result = spawnSync(wrangler, ['secret', 'bulk', ...args], {
    input: JSON.stringify(values),
    encoding: 'utf8',
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Wrangler secret sync failed (${result.status ?? result.error?.message ?? 'unknown'})`);
  }
}
const deploy = spawnSync(wrangler, ['deploy', '--config', 'wrangler.staging-agent.toml'], {
  encoding: 'utf8', env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
});
if (deploy.error || deploy.status !== 0) throw new Error(`Staging test agent deploy failed (${deploy.status ?? deploy.error?.message ?? 'unknown'})`);
sync(['--config', 'wrangler.staging-agent.toml'], { AGENT_SECRET: agentSecret });
sync(['--env', 'staging'], {
  AGENT_SECRET: agentSecret,
  TELEGRAM_WEBHOOK_SECRET: webhookSecret,
});
// Workers secret changes create new versions. Give global routes a short
// propagation window before the signed webhook probe starts.
await new Promise(resolve => setTimeout(resolve, 8000));
const probe = await fetch('https://trained-assist-tg-test-agent-staging.skillset-apply.workers.dev/project-decision?username=tgpatrol_20261007_v1', {
  headers: { Authorization: `Bearer ${agentSecret}`, 'user-agent': 'tg-staging-secret-sync/1.0' },
});
if (!probe.ok) throw new Error(`Staging test agent auth probe returned HTTP ${probe.status}`);
console.log('Synchronized isolated staging agent and webhook secrets. Values are not displayed.');
