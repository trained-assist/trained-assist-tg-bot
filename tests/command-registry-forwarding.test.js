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
