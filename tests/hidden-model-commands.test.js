import { describe, it, expect } from 'vitest';
import commandsRegistry from '../commands-registry.json';
import { isCommandVisible } from '../src/lib/command-visibility.js';

// Owner rule: the model/engine-switching commands are not part of the user-facing
// command menu — they stay callable when typed (the gateway still forwards them /
// the unknown-command fallback reaches the agent) but must not be advertised in
// /start or setMyCommands. Project commands stay visible.
const MODEL_COMMANDS = [
  '/switch2klod', '/switch2codex', '/switch2opencode',
  '/oc_value', '/oc_free', '/oc_ru', '/oc_go', '/oc_openrouter',
  '/oc_deepseek', '/oc_ds_or', '/oc_ds_go',
];

function entryFor(command) {
  return commandsRegistry.commands.find(
    (c) => c.command === command || (c.aliases || []).includes(command)
  );
}

describe('model-switching commands are hidden from the menu', () => {
  it.each(MODEL_COMMANDS)('%s is not advertised to any audience', (command) => {
    const entry = entryFor(command);
    expect(entry, `${command} missing from commands-registry.json`).toBeTruthy();
    expect(entry.hidden).toBe(true);
    expect(isCommandVisible(entry, 'default')).toBe(false);
    expect(isCommandVisible(entry, 'freelance')).toBe(false);
    expect(isCommandVisible(entry, 'recruiter')).toBe(false);
  });
});

describe('project commands stay visible', () => {
  it('is advertised to the default and freelance audiences', () => {
    const entry = entryFor('/project');
    expect(entry).toBeTruthy();
    expect(isCommandVisible(entry, 'default')).toBe(true);
    expect(isCommandVisible(entry, 'freelance')).toBe(true);
  });
});
