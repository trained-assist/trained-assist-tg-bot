import { describe, it, expect, vi, beforeEach } from 'vitest';

// The shared text-routing rule (#530 group path): both the private and the group
// branch of dispatchInner call routeText, so this one helper decides whether a
// message accumulates in the intake buffer or goes straight to the agent. These
// tests lock that a plain text message ALWAYS buffers (no per-message session)
// and that the documented bypasses still reach handleMessage directly.

const handleMessage = vi.fn();
const openProjectChoice = vi.fn();
vi.mock('../src/handlers/message.js', () => ({ handleMessage: (...a) => handleMessage(...a) }));
// commands/callbacks/etc. are pulled in transitively by index.js; stub the heavy ones.
vi.mock('../src/handlers/commands.js', () => ({ handleCommand: vi.fn(), isAdminForwardedCommand: () => false }));
vi.mock('../src/handlers/user-mgmt.js', () => ({ handleUserMgmt: vi.fn(), isUserMgmtCommand: () => false }));
vi.mock('../src/handlers/callbacks.js', () => ({ handleCallbackQuery: vi.fn() }));
vi.mock('../src/lib/kv.js', () => ({ getSession: vi.fn(), getOrCreateMappedSession: vi.fn() }));
vi.mock('../src/lib/telegram.js', () => ({ sendMessage: vi.fn() }));
vi.mock('../src/lib/agent-client.js', () => ({ getProjectDecision: vi.fn().mockResolvedValue({ action: 'auto', choices: [] }) }));
vi.mock('../src/lib/project-choice.js', () => ({ openProjectChoice: (...a) => openProjectChoice(...a) }));

import { routeText } from '../src/index.js';
import { getSession } from '../src/lib/kv.js';
import { getProjectDecision } from '../src/lib/agent-client.js';

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

beforeEach(() => { vi.clearAllMocks(); getProjectDecision.mockResolvedValue({ action: 'auto', choices: [] }); });

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
    expect(_appended[0].msg.intakeRoute).toEqual({ sessionId: 'original', projectId: 'project-1', forceNew: false, projectChosen: false, projectPicked: false, newProject: false, contextFromSession: null });
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('pins an explicitly chosen project for plain text before later menu changes', async () => {
    const { getSession } = await import('../src/lib/kv.js');
    getSession.mockResolvedValueOnce({ activeSessionId: 'fresh', activeSessionIsNew: true,
      projectSelectionSessionId: 'fresh', projectId: 'chosen', pendingNewProject: false });
    const { env, _appended } = makeEnv();
    await routeText({ chat: { id: 42 }, text: 'task' }, env, 42);
    expect(_appended[0].msg.intakeRoute).toMatchObject({ sessionId: 'fresh', projectChosen: true,
      projectId: 'chosen', forceNew: true });
  });

  it('honours the kill-switch — routes straight to the agent when off', async () => {
    const { env, _appended } = makeEnv();
    env.INTAKE_DEBOUNCE = 'off';
    await routeText({ chat: { id: 42 }, text: 'что угодно' }, env, 42);
    expect(_appended).toHaveLength(0);
    expect(handleMessage).toHaveBeenCalledTimes(1);
  });

  it('shows project picker immediately for brand-new session with ≥2 projects', async () => {
    const { env, _appended } = makeEnv();
    getSession.mockResolvedValueOnce({ username: 'alice' }); // no lastSessionId
    getProjectDecision.mockResolvedValueOnce({ action: 'ask', choices: [{ id: 'p1' }, { id: 'p2' }], active: 'p1' });
    openProjectChoice.mockResolvedValueOnce();
    const msg = { chat: { id: 42 }, text: 'привет, хочу начать работу' };
    await routeText(msg, env, 42);
    expect(openProjectChoice).toHaveBeenCalledTimes(1);
    expect(openProjectChoice.mock.calls[0][3]).toMatchObject({ input: msg });
    expect(_appended).toHaveLength(0); // did NOT go into the buffer
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('buffers normally when brand-new session has only one project', async () => {
    const { env, _appended } = makeEnv();
    getSession.mockResolvedValueOnce({ username: 'alice' }); // no lastSessionId
    getProjectDecision.mockResolvedValueOnce({ action: 'auto', choices: [{ id: 'p1' }] });
    await routeText({ chat: { id: 42 }, text: 'привет' }, env, 42);
    expect(openProjectChoice).not.toHaveBeenCalled();
    expect(_appended).toHaveLength(1); // went into buffer normally
  });

  it('buffers normally for returning user even when multi-project (picker shown after ▶️)', async () => {
    const { env, _appended } = makeEnv();
    getSession.mockResolvedValueOnce({ username: 'alice', lastSessionId: 'prev-session' });
    await routeText({ chat: { id: 42 }, text: 'новый вопрос' }, env, 42);
    expect(openProjectChoice).not.toHaveBeenCalled();
    expect(_appended).toHaveLength(1);
    expect(getProjectDecision).not.toHaveBeenCalled(); // no API call for returning users
  });
});
