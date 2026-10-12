import { readFileSync } from 'node:fs';
import { it, expect } from 'vitest';

const wrangler = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

it('routes the production bot to CP with active ingress, delivery and stop', () => {
  expect(wrangler).toMatch(/^main = "src\/index\.js"$/m);
  for (const [name, value] of [
    ['EXECUTION_BACKEND', 'control-plane'],
    ['CONTROL_PLANE_URL', 'https://trained-assist-cp-production.skillset-apply.workers.dev'],
    ['TG_PRODUCTION_E2E_MODE', 'true'],
    ['TG_SLICE_ROUTER_ENABLED', 'true'],
    ['TG_SLICE_DELIVERY_PAUSED', 'false'],
    ['TG_SLICE_INGRESS_PAUSED', 'false'],
    ['TG_SLICE_STOP_ENABLED', 'true'],
  ]) expect(wrangler).toContain(`${name} = "${value}"`);
  expect(wrangler).toContain('TG_SLICE_ALLOWED_CHATS = "1714048"');
  expect(wrangler).toContain('TG_SLICE_ALLOWED_USERS = "1714048"');
  expect(wrangler).toContain('class_name = "ProductionE2eIntakeBuffer"');
  expect(wrangler).toContain('class_name = "ProductionE2eTgDeliveryOwner"');
});

it('keeps named staging and secondary bot environments on the legacy entrypoint', () => {
  for (const name of ['staging', 'recruiter', 'freelance', 'sales']) {
    expect(wrangler).toMatch(new RegExp(`^\\[env\\.${name}\\][\\s\\S]{0,100}^main = "src/index\\.js"$`, 'm'));
  }
});

it('syncs the scoped production CP signature from the protected repository secret', () => {
  expect(ci).toContain('secrets.CONTROL_PLANE_PRODUCTION_E2E_SIGNATURE');
  expect(ci).toContain('wrangler secret put CONTROL_PLANE_PRODUCTION_E2E_SIGNATURE');
});
