import { readFileSync } from 'node:fs';
import { it, expect } from 'vitest';

const wrangler = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

it('routes the production bot to CP with an open production lane', () => {
  expect(wrangler).toMatch(/^main = "src\/index\.js"$/m);
  for (const [name, value] of [
    ['EXECUTION_BACKEND', 'control-plane'],
    ['CONTROL_PLANE_URL', 'https://trained-assist-cp-production.skillset-apply.workers.dev'],
    ['CONTROL_PLANE_PRINCIPAL', 'gateway'],
    ['CONTROL_PLANE_PROFILE', 'trained-assist-production'],
    ['TG_SLICE_ROUTER_ENABLED', 'true'],
    ['TG_SLICE_DELIVERY_PAUSED', 'false'],
    ['TG_SLICE_INGRESS_PAUSED', 'false'],
    ['TG_SLICE_STOP_ENABLED', 'true'],
  ]) expect(wrangler).toContain(`${name} = "${value}"`);
  expect(wrangler).toContain('TG_SLICE_ALLOWED_CHATS = ""');
  expect(wrangler).toContain('TG_SLICE_ALLOWED_USERS = ""');
  expect(wrangler).toContain('class_name = "IntakeBuffer"');
  expect(wrangler).toContain('class_name = "TgDeliveryOwner"');
});

it('keeps named staging and secondary bot environments on the legacy entrypoint', () => {
  for (const name of ['staging', 'recruiter', 'freelance', 'sales']) {
    expect(wrangler).toMatch(new RegExp(`^\\[env\\.${name}\\][\\s\\S]{0,100}^main = "src/index\\.js"$`, 'm'));
  }
});

it('syncs the ordinary production gateway principal credentials', () => {
  expect(ci).toContain('secrets.CONTROL_PLANE_PRINCIPAL_SIGNATURE');
  expect(ci).toContain('secrets.CONTROL_PLANE_SECRET');
  expect(ci).toContain('node tools/deploy-main-worker.mjs');
  expect(ci).not.toContain('wrangler secret put');
});
