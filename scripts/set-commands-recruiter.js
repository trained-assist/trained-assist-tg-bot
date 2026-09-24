#!/usr/bin/env node
// One-shot script: registers the recruiter bot's command list in Telegram.
// Reads from commands-registry.json (single source of truth). The recruiter
// worker also calls setMyCommands on boot, so this script only needs to be
// run by hand if the worker is offline.
//
// Usage: BOT_TOKEN=xxx node scripts/set-commands-recruiter.js

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { isCommandVisible } from '../src/lib/command-visibility.js';

const token = process.env.BOT_TOKEN || process.argv[2];
if (!token) {
  console.error('Usage: BOT_TOKEN=xxx node scripts/set-commands-recruiter.js');
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const registry = JSON.parse(readFileSync(join(__dirname, '../commands-registry.json'), 'utf8'));
const commands = [];
const seen = new Set();
for (const entry of registry.commands) {
  // Same visibility helper the worker uses (src/lib/command-visibility.js) —
  // this script is the manual fallback for when the worker is offline.
  if (!isCommandVisible(entry, 'recruiter')) continue;
  if (seen.has(entry.command)) continue;
  seen.add(entry.command);
  const name = entry.command.replace(/^\//, '');
  if (!/^[a-z0-9_]{1,32}$/.test(name)) {
    console.error(`⚠️  skipping "${name}" — invalid Telegram command name`);
    continue;
  }
  commands.push({ command: name, description: entry.description });
}

const res = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ commands }),
});
const json = await res.json();
if (json.ok) {
  console.log(`✅ Зарегистрировано ${commands.length} команд.`);
} else {
  console.error('❌ Ошибка:', JSON.stringify(json));
  process.exit(1);
}