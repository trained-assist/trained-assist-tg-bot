#!/usr/bin/env node
// Fails the build if commands-registry.json drifts from the actual switch in
// src/handlers/commands.js. This is the "test at redeploy" half of the command
// registry: every "local" entry must have a real case in the switch, and the file
// must not list the same command twice. It runs as part of `npm run check`, which
// ci.yml already runs before every deploy.
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const registry = JSON.parse(readFileSync(join(__dirname, '../commands-registry.json'), 'utf8'));
const commandsSource = readFileSync(join(__dirname, '../src/handlers/commands.js'), 'utf8');

const errors = [];
const seen = new Set();

for (const entry of registry.commands) {
  for (const cmd of [entry.command, ...entry.aliases]) {
    if (seen.has(cmd)) errors.push(`"${cmd}" is listed more than once in commands-registry.json`);
    seen.add(cmd);

    if (entry.handler === 'local') {
      const caseLine = `case '${cmd}':`;
      if (!commandsSource.includes(caseLine)) {
        errors.push(`"${cmd}" is registered as handler:"local" but src/handlers/commands.js has no \`${caseLine}\``);
      }
    } else if (entry.handler !== 'forward') {
      errors.push(`"${cmd}" has unknown handler "${entry.handler}" (expected "local" or "forward")`);
    }
  }
}

if (errors.length) {
  console.error('commands-registry.json is out of sync with src/handlers/commands.js:\n');
  for (const e of errors) console.error(`  - ${e}`);
  console.error('\nFix the registry entry or the switch case, then re-run.');
  process.exit(1);
}

console.log(`commands-registry.json OK — ${seen.size} commands/aliases in sync with commands.js.`);
