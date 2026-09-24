#!/usr/bin/env node
// One-shot script: registers bot command list in Telegram from commands-registry.json
// (single source of truth shared with src/handlers/commands.js#cmdStart and
//  src/lib/telegram.js#registerBotCommands). The worker also calls setMyCommands
//  on boot, so this script only needs to be run by hand if the worker is offline.
//
// Usage: BOT_TOKEN=xxx node scripts/set-commands.js

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { isCommandVisible } from '../src/lib/command-visibility.js';

const token = process.env.BOT_TOKEN || process.argv[2];
if (!token) {
  console.error('Usage: BOT_TOKEN=xxx node scripts/set-commands.js');
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const registry = JSON.parse(readFileSync(join(__dirname, '../commands-registry.json'), 'utf8'));
const commands = [];
const seen = new Set();
for (const entry of registry.commands) {
  // Same visibility helper the worker uses (src/lib/command-visibility.js) —
  // this bot's audience is 'default'.
  if (!isCommandVisible(entry, 'default')) continue;
  if (seen.has(entry.command)) continue;
  seen.add(entry.command);
  commands.push({ command: entry.command.replace(/^\//, ''), description: entry.description });
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