import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { renderProductionE2eWorkerConfig } from '../tools/render-production-e2e-worker-config.mjs';

const sandboxConfig = await readFile(new URL('../wrangler.sandbox-tg-sandbox3.toml', import.meta.url), 'utf8');

describe('temporary production E2E Worker config', () => {
  it.each([[true, '"true"'], [false, '"false"']])('writes pause=%s as TOML strings and preserves sandbox state bindings', (paused, encoded) => {
    const rendered = renderProductionE2eWorkerConfig(sandboxConfig, { paused });
    expect(rendered).toContain(`TG_SLICE_INGRESS_PAUSED = ${encoded}`);
    expect(rendered).toContain(`TG_SLICE_DELIVERY_PAUSED = ${encoded}`);
    expect(rendered).toContain('CONTROL_PLANE_URL = "https://trained-assist-cp-production.skillset-apply.workers.dev"');
    expect(rendered).toContain('CONTROL_PLANE_PRINCIPAL = "production-e2e-telegram-v1"');
    expect(rendered).toContain('CONTROL_PLANE_PROFILE = "production-e2e-telegram-v1"');
    expect(rendered).toContain('SESSION_NAMESPACE = "integrator-production-e2e-v1"');
    expect(rendered).toContain('id = "f81925f900dc42fca7bec33d9d422840"');
    expect(rendered).toContain('id = "9fbaf8e6a86f4673bf0990b540e75f6d"');
    expect(rendered).toContain('service = "trained-assist-cp-sandbox3"');
    expect(rendered).toContain('[exports.ProductionE2eIntakeBuffer]');
    expect(rendered).toContain('class_name = "ProductionE2eIntakeBuffer"');
    expect(rendered).toContain('[exports.ProductionE2eTgDeliveryOwner]');
    expect(rendered).toContain('class_name = "ProductionE2eTgDeliveryOwner"');
    expect(rendered).not.toContain('class_name = "IntakeBuffer"');
    expect(rendered).not.toContain('class_name = "TgDeliveryOwner"');
  });
});
