import { describe, it, expect, vi, beforeEach } from 'vitest';

// The shared text-routing rule (#530 group path): both the private and the group
// branch of dispatchInner call routeText, so this one helper decides whether a
// message accumulates in the intake buffer or goes straight to the agent. These
// tests lock that a plain text message ALWAYS buffers (no per-message session)
// and that the documented bypasses still reach handleMessage directly.

const handleMessage = vi.fn();
vi.mock('../src/handlers/message.js', () => ({ handleMessage: (...a) => handleMessage(...a) }));
// commands/callbacks/etc. are pulled in transitively by index.js; stub the heavy ones.
vi.mock('../src/handlers/commands.js', () => ({ handleCommand: vi.fn(), isAdminForwardedCommand: () => false }));
vi.mock('../src/handlers/user-mgmt.js', () => ({ handleUserMgmt: vi.fn(), isUserMgmtCommand: () => false }));
vi.mock('../src/handlers/callbacks.js', () => ({ handleCallbackQuery: vi.fn() }));
vi.mock('../src/lib/kv.js', () => ({ getSession: vi.fn(), getOrCreateMappedSession: vi.fn() }));
vi.mock('../src/lib/telegram.js', () => ({ sendMessage: vi.fn() }));

import { routeText } from '../src/index.js';
import { getSession } from '../src/lib/kv.js';

function makeEnv() {
  const appended = [];
  const stub = { fetch: vi.fn(async (_url, init) => { appended.push(JSON.parse(init.body)); return new Response('{}'); }) };
  return {
    _appended: appended,
    env: {
      INTAKE_DEBOUNCE: 'on',
      BOT_TOKEN: 't',
      INTAKE: { idFromName: (n) => n, get: () => stub },
    },
  };
}

beforeEach(() => { handleMessage.mockClear(); });

describe('routeText — shared private+group intake rule', () => {
  it('buffers a plain text message instead of launching a session per message', async () => {
    const { env, _appended } = makeEnv();
    await routeText({ chat: { id: 42 }, text: 'быстрая мысль' }, env, 42);
    expect(handleMessage).not.toHaveBeenCalled();
    expect(_appended).toHaveLength(1);
    expect(_appended[0]).toMatchObject({ text: 'быстрая мысль', flush: false });
  });

  it('flushes immediately on a bare force word', async () => {
    const { env, _appended } = makeEnv();
    await routeText({ chat: { id: 42 }, text: 'го' }, env, 42);
    expect(_appended[0].flush).toBe(true);
  });

  it('does not flush on prose that merely contains a force-ish word', async () => {
    const { env, _appended } = makeEnv();
    await routeText({ chat: { id: 42 }, text: 'давай сделаем разбор' }, env, 42);
    expect(_appended[0].flush).toBe(false);
  });

  it('buffers a reply-to-bot so the user can add attachments', async () => {
    const { env, _appended } = makeEnv();
    getSession.mockResolvedValueOnce({ lastSessionId: 'original', projectId: 'project-1' });
    await routeText({ chat: { id: 42 }, text: 'да', reply_to_message: { message_id: 1 } }, env, 42);
    expect(_appended).toHaveLength(1);
    expect(_appended[0].msg.intakeRoute).toEqual({ sessionId: 'original', projectId: 'project-1', forceNew: false, contextFromSession: null });
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('honours the kill-switch — routes straight to the agent when off', async () => {
    const { env, _appended } = makeEnv();
    env.INTAKE_DEBOUNCE = 'off';
    await routeText({ chat: { id: 42 }, text: 'что угодно' }, env, 42);
    expect(_appended).toHaveLength(0);
    expect(handleMessage).toHaveBeenCalledTimes(1);
  });
});
