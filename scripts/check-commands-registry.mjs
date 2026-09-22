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

// Allowed HTML tags in description text. /start renders these inside parse_mode=HTML
// messages via src/handlers/commands.js#cmdStart — Telegram rejects the whole batch
// if any other <…> looks like an opening tag (the "ноль реакции на /start" bug,
// traced to a raw "<id>" in /hh_send's description).
const ALLOWED_TAGS = new Set(['b', 'i', 'u', 's', 'code', 'pre']);

for (const entry of registry.commands) {
  // Telegram's setMyCommands rejects the WHOLE batch if any single command name
  // doesn't match [a-z0-9_]{1,32} — e.g. a hyphen. Before this check existed,
  // "/oc_lavish-luna" shipped, and every bot's menu silently stopped updating on
  // every isolate boot (2026-09-22) with nothing but a console.error to show for
  // it. Catch it at CI time instead of relying on the runtime skip in
  // src/lib/telegram.js#registerBotCommands.
  const name = entry.command.replace(/^\//, '');
  if (!/^[a-z0-9_]{1,32}$/.test(name)) {
    errors.push(`"${entry.command}" is not a valid Telegram command name (must be 1-32 chars, lowercase a-z0-9_ only) — it will break setMyCommands for every bot.`);
  }

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

  // Reject descriptions containing raw HTML tags that /start would later try to
  // render with parse_mode=HTML — escape them with &lt;/&gt; instead. Catches
  // the bug class at build time so a future registry edit can't ship the same
  // silent-failure regression to /start.
  const desc = entry.description || '';
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
  let m;
  while ((m = tagRe.exec(desc)) !== null) {
    const tag = m[1].toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) {
      errors.push(`"${entry.command}" description has unescaped <${tag}> — Telegram HTML parser will reject the whole /start message. Use &lt;${tag}&gt; instead.`);
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
