import { describe, it, expect, vi, beforeEach } from 'vitest';
import commandsRegistry from '../commands-registry.json';

vi.mock('../src/handlers/message.js', () => ({ handleMessage: vi.fn().mockResolvedValue({}) }));
vi.mock('../src/lib/telegram.js', () => ({
  sendMessage: vi.fn().mockResolvedValue({}),
  sendMessageWithKeyboard: vi.fn().mockResolvedValue({}),
}));

import { handleCommand } from '../src/handlers/commands.js';
import { handleMessage } from '../src/handlers/message.js';
import { sendMessage } from '../src/lib/telegram.js';

// Previously these hit the switch's `default:` case (❓ Неизвестная команда) because
// the agent already implemented them but the gateway's forward-allowlist never
// mentioned them. They must now reach the agent instead of dead-ending locally.
const forwardOnlyCommands = commandsRegistry.commands
  .filter((c) => c.handler === 'forward')
  .flatMap((c) => [c.command, ...c.aliases])
  // /report, /bug, /feature etc. are covered by tests/commands.test.js's existing
  // suite; keep this list focused on the newly-fixed, previously-dead ones.
  .filter((cmd) => !['/persona', '/role', '/роль', '/персона', '/character', '/характер',
    '/project', '/projects', '/проект', '/проекты',
    '/bug_or_feature', '/bug', '/feature', '/баг', '/фича', '/report', '/репорт',
    '/get_webpass', '/webpass', '/вебпароль'].includes(cmd));

describe('newly-forwarded agent commands reach the agent, not the "unknown command" default', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(forwardOnlyCommands)('%s is forwarded via handleMessage', async (cmd) => {
    await handleCommand({ chat: { id: 1 }, text: cmd, from: { id: 1 } }, {});
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

// Unified fallback (owner rule): `known command → its handler`, `unknown command →
// agent`. An unregistered command must never dead-end on "❓ Неизвестная команда" —
// the original message goes to the agent so it can interpret the command's meaning
// itself. This is what makes agent-side/future commands work without a gateway
// deploy: absence from commands-registry.json must not block reaching the agent.
describe('unregistered commands fall through to the agent', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    '/spec_preferences',
    '/show_candidates',
    '/some_command',
    '/typo_login',
    '/totally_unknown_thing@super_personal_assistant_bot',
  ])('%s is forwarded via handleMessage untouched', async (cmd) => {
    const msg = { chat: { id: 1 }, text: cmd, from: { id: 1 } };
    await handleCommand(msg, {});
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(handleMessage.mock.calls[0][0].text).toBe(cmd);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

// Explicit contract: deriving every case from the registry alone misses removed commands.
describe('requested checklist command', () => {
  beforeEach(() => vi.clearAllMocks());
  it.each(['/show_active_cheklist', '/active_checklist'])('%s reaches the agent intact', async (cmd) => {
    const msg = { chat: { id: 1 }, text: cmd, from: { id: 1 } };
    await handleCommand(msg, {});
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(handleMessage.mock.calls[0][0].text).toBe(cmd);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
