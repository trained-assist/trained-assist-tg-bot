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
sync(['--config', 'wrangler.staging-agent.toml'], { AGENT_SECRET: agentSecret });
sync(['--env', 'staging'], {
  AGENT_SECRET: agentSecret,
  TELEGRAM_WEBHOOK_SECRET: webhookSecret,
});
console.log('Synchronized isolated staging agent and webhook secrets. Values are not displayed.');
