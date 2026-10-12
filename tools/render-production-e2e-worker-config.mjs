import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const PRODUCTION_CONTROL_PLANE_URL = 'https://trained-assist-cp-production.skillset-apply.workers.dev';

function setTomlString(source, name, value) {
  const pattern = new RegExp(`^${name} = .*?$`, 'm');
  const matches = source.match(pattern) ?? [];
  if (matches.length !== 1) throw new Error(`wrangler_var_not_unique_${name}`);
  return source.replace(pattern, `${name} = ${JSON.stringify(value)}`);
}

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`wrangler_config_not_unique_${label}`);
  }
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

function omitCronTriggerTable(source) {
  const lines = source.split(/\r?\n/);
  const starts = lines.flatMap((line, index) => line.trim() === '[triggers]' ? [index] : []);
  if (starts.length !== 1) throw new Error('wrangler_trigger_table_not_unique');
  const start = starts[0];
  let end = start + 1;
  while (end < lines.length && !/^\s*\[\[?[^\]]+\]\]?\s*$/.test(lines[end])) end += 1;
  const entries = lines.slice(start + 1, end).filter(line => line.trim() && !line.trim().startsWith('#'));
  if (entries.length !== 1 || !/^\s*crons\s*=/.test(entries[0])) {
    throw new Error('wrangler_trigger_table_unexpected_contents');
  }
  lines.splice(start, end - start);
  return lines.join('\n');
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
  // The canary does not need scheduled invocations. Leaving triggers.crons
  // undefined tells Wrangler to keep the existing sandbox schedule unchanged
  // and avoids making the unrelated schedules API part of the canary deploy.
  output = omitCronTriggerTable(output);
  // The pinned production test chat is also used in sandbox3. Give the canary
  // its own DO namespaces so chat-keyed intake scope and delivery state cannot
  // collide with the sandbox3 profile that uses the same Telegram chat ID.
  output = replaceOnce(output, 'class_name = "TgDeliveryOwner"', 'class_name = "ProductionE2eTgDeliveryOwner"', 'delivery_owner_binding');
  output = replaceOnce(output, 'class_name = "IntakeBuffer"', 'class_name = "ProductionE2eIntakeBuffer"', 'intake_binding');
  if (!output.includes('id = "f81925f900dc42fca7bec33d9d422840"') ||
      !output.includes('id = "9fbaf8e6a86f4673bf0990b540e75f6d"') ||
      !output.includes('service = "trained-assist-cp-sandbox3"')) {
    throw new Error('sandbox3_state_bindings_changed');
  }
  if (!output.includes('[exports.ProductionE2eIntakeBuffer]') ||
      !output.includes('[exports.ProductionE2eTgDeliveryOwner]') ||
      output.includes('class_name = "IntakeBuffer"') ||
      output.includes('class_name = "TgDeliveryOwner"')) {
    throw new Error('production_e2e_state_namespaces_not_isolated');
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
