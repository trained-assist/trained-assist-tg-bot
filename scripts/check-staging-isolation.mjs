import { readFileSync } from 'node:fs';

const source = readFileSync(process.argv[2] || 'wrangler.toml', 'utf8');
const marker = '[env.staging]';
if (source.split(marker).length !== 2) throw new Error('Expected exactly one staging environment');
const [production, rest] = source.split(marker);
const staging = rest.split(/^\[env\.(?!staging(?:\.|\]))/m)[0];
function namespaces(text, prefix) {
  const result = new Map();
  for (const section of text.split(/(?=^\[)/m)) {
    if (!section.startsWith(`[[${prefix}kv_namespaces]]`)) continue;
    const name = section.match(/^binding\s*=\s*"([^"]+)"/m)?.[1];
    const id = section.match(/^id\s*=\s*"([a-f0-9]{32})"/m)?.[1];
    if (!name || !id || result.has(name)) throw new Error('Invalid or duplicate KV binding');
    result.set(name, id);
  }
  return result;
}
const prod = namespaces(production, '');
const stage = namespaces(staging, 'env.staging.');
for (const name of ['USERS', 'SESSIONS']) {
  if (!prod.has(name) || !stage.has(name)) throw new Error(`Missing KV binding: ${name}`);
}
if (new Set(stage.values()).size !== stage.size) throw new Error('Staging namespaces must be distinct');
for (const id of stage.values()) {
  if ([...prod.values()].includes(id)) throw new Error('Staging must not share production KV');
}
console.log('Staging KV isolation: OK');
