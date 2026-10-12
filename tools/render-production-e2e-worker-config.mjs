import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const PRODUCTION_CONTROL_PLANE_URL = 'https://trained-assist-cp-production.skillset-apply.workers.dev';

function setTomlString(source, name, value) {
  const pattern = new RegExp(`^${name} = .*?$`, 'm');
  const matches = source.match(pattern) ?? [];
  if (matches.length !== 1) throw new Error(`wrangler_var_not_unique_${name}`);
  return source.replace(pattern, `${name} = ${JSON.stringify(value)}`);
}

export function renderProductionE2eWorkerConfig(source, { paused }) {
  if (typeof source !== 'string' || typeof paused !== 'boolean') throw new Error('invalid_production_e2e_config_input');
  let output = source;
  const vars = {
    CONTROL_PLANE_URL: PRODUCTION_CONTROL_PLANE_URL,
    CONTROL_PLANE_PRINCIPAL: 'production-e2e-telegram-v1',
    CONTROL_PLANE_PROFILE: 'production-e2e-telegram-v1',
    SESSION_NAMESPACE: 'integrator-production-e2e-v1',
    TG_SLICE_INGRESS_PAUSED: String(paused),
    TG_SLICE_DELIVERY_PAUSED: String(paused),
  };
  for (const [name, value] of Object.entries(vars)) output = setTomlString(output, name, value);
  if (!output.includes('id = "f81925f900dc42fca7bec33d9d422840"') ||
      !output.includes('id = "9fbaf8e6a86f4673bf0990b540e75f6d"') ||
      !output.includes('service = "trained-assist-cp-sandbox3"')) {
    throw new Error('sandbox3_state_bindings_changed');
  }
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, target] = process.argv.slice(2);
  if (!['paused', 'live'].includes(mode) || !target) throw new Error('usage: render-production-e2e-worker-config.mjs paused|live output.toml');
  const source = await readFile(new URL('../wrangler.sandbox-tg-sandbox3.toml', import.meta.url), 'utf8');
  const rendered = renderProductionE2eWorkerConfig(source, { paused: mode === 'paused' });
  await writeFile(target, rendered, { mode: 0o600 });
}
