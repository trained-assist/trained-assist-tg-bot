import { readFileSync } from 'node:fs';
import { it, expect } from 'vitest';

const workerConfig = readFileSync(new URL('../wrangler.sandbox-tg-sandbox3.toml', import.meta.url), 'utf8');
const workerEntrypoint = readFileSync(new URL('../src/sandbox-tg/existing-ux.js', import.meta.url), 'utf8');

it('retains the retired production-E2E namespaces as compatibility exports only', () => {
  for (const name of ['ProductionE2eTgDeliveryOwner', 'ProductionE2eIntakeBuffer']) {
    expect(workerConfig).toContain(`[exports.${name}]\ntype = "durable-object"\nstorage = "sqlite"`);
    expect(workerEntrypoint).toContain(`${name}`);
    expect(workerConfig).not.toContain(`class_name = "${name}"`);
  }
  expect(workerConfig).toContain('service = "trained-assist-cp-sandbox3"');
  expect(workerConfig).not.toContain('trained-assist-cp-production');
  expect(workerConfig).not.toMatch(/new_sqlite_classes\s*=\s*\[[^\]]*ProductionE2e/);
});
