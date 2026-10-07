import { describe, it, expect, vi, beforeEach } from 'vitest';

// The shared text-routing rule (#530 group path): both the private and the group
// branch of dispatchInner call routeText, so this one helper decides whether a
// message accumulates in the intake buffer or goes straight to the agent. These
// tests lock that user-authored content is admitted to the durable buffer before
// project/session routing, independent of the debounce toggle.

const handleMessage = vi.fn();
const openProjectChoice = vi.fn();
vi.mock('../src/handlers/message.js', () => ({ handleMessage: (...a) => handleMessage(...a) }));
// commands/callbacks/etc. are pulled in transitively by index.js; stub the heavy ones.
const handleCommand = vi.fn();
vi.mock('../src/handlers/commands.js', () => ({ handleCommand: (...a) => handleCommand(...a), isAdminForwardedCommand: () => false }));
vi.mock('../src/handlers/user-mgmt.js', () => ({ handleUserMgmt: vi.fn(), isUserMgmtCommand: () => false }));
vi.mock('../src/handlers/callbacks.js', () => ({ handleCallbackQuery: vi.fn() }));
vi.mock('../src/lib/kv.js', () => ({ getSession: vi.fn(), getOrCreateMappedSession: vi.fn() }));
vi.mock('../src/lib/telegram.js', () => ({ sendMessage: vi.fn() }));
vi.mock('../src/lib/agent-client.js', () => ({ getProjectDecision: vi.fn().mockResolvedValue({ action: 'auto', choices: [] }) }));
vi.mock('../src/lib/project-choice.js', () => ({ openProjectChoice: (...a) => openProjectChoice(...a) }));

import { routeText } from '../src/index.js';
import { getSession } from '../src/lib/kv.js';
import { getProjectDecision } from '../src/lib/agent-client.js';
import { sendMessage } from '../src/lib/telegram.js';

function makeEnv() {
  const appended = [];
  const stub = { fetch: vi.fn(async (_url, init) => { appended.push(JSON.parse(init.body)); return new Response('{}'); }) };
  return {
    _appended: appended,
    env: {
      INTAKE_DEBOUNCE: 'on',
      BOT_TOKEN: 't',
      SESSIONS: {},
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

  it('buffers project configuration phrases before routing them', async () => {
    const { env, _appended } = makeEnv();
    getSession.mockResolvedValue({ username: 'u' });
    getProjectDecision.mockResolvedValue({ action: 'ask', choices: [{ id: 'a' }, { id: 'b' }] });
    await routeText({ chat: { id: 42 }, text: 'закрепи Фриланс-заказы' }, env, 42);
    expect(handleCommand).not.toHaveBeenCalled();
    expect(openProjectChoice).not.toHaveBeenCalled();
    expect(_appended).toHaveLength(1);
    expect(_appended[0].text).toBe('закрепи Фриланс-заказы');
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

  it('still buffers user input when the debounce toggle is off', async () => {
    const { env, _appended } = makeEnv();
    env.INTAKE_DEBOUNCE = 'off';
    await routeText({ chat: { id: 42 }, text: 'что угодно' }, env, 42);
    expect(_appended).toHaveLength(1);
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('does not call the legacy project API or show a picker before buffering a new session', async () => {
    const { env, _appended } = makeEnv();
    getSession.mockResolvedValueOnce({ username: 'alice' }); // no lastSessionId
    getProjectDecision.mockResolvedValueOnce({ action: 'ask', choices: [{ id: 'p1' }, { id: 'p2' }], active: 'p1' });
    openProjectChoice.mockResolvedValueOnce();
    const msg = { chat: { id: 42 }, text: 'привет, хочу начать работу' };
    await routeText(msg, env, 42);
    expect(openProjectChoice).not.toHaveBeenCalled();
    expect(getProjectDecision).not.toHaveBeenCalled();
    expect(_appended).toHaveLength(1);
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('buffers normally when brand-new session has only one project', async () => {
    const { env, _appended } = makeEnv();
    getSession.mockResolvedValueOnce({ username: 'alice' }); // no lastSessionId
    await routeText({ chat: { id: 42 }, text: 'привет' }, env, 42);
    expect(openProjectChoice).not.toHaveBeenCalled();
    expect(_appended).toHaveLength(1); // went into buffer normally
    expect(getProjectDecision).not.toHaveBeenCalled();
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

describe('routeText — forum topic routing (#255)', () => {
  function makeTopicEnv() {
    const keys = [];
    const stub = { fetch: vi.fn(async () => new Response('{}')) };
    return {
      keys,
      env: {
        INTAKE_DEBOUNCE: 'on',
        BOT_TOKEN: 't',
        INTAKE: { idFromName: (n) => { keys.push(n); return n; }, get: () => stub },
      },
    };
  }

  it('keys the Intake DO by chatId:threadId for a forum message', async () => {
    const { env, keys } = makeTopicEnv();
    getSession.mockResolvedValueOnce({ username: 'alice', lastSessionId: 's-1' });
    await routeText({ chat: { id: -100, type: 'supergroup' }, text: 'задача A', is_topic_message: true, message_thread_id: 7 }, env, -100);
    expect(keys).toEqual(['-100:7']);
  });

  it('keys each topic separately so text A and text B never share a buffer', async () => {
    const a = makeTopicEnv();
    getSession.mockResolvedValueOnce({ username: 'alice', lastSessionId: 's-1' });
    await routeText({ chat: { id: -100, type: 'supergroup' }, text: 'A', is_topic_message: true, message_thread_id: 1 }, a.env, -100);
    getSession.mockResolvedValueOnce({ username: 'alice', lastSessionId: 's-2' });
    await routeText({ chat: { id: -100, type: 'supergroup' }, text: 'B', is_topic_message: true, message_thread_id: 2 }, a.env, -100);
    expect(a.keys).toEqual(['-100:1', '-100:2']);
  });

  it('keeps the legacy chatId key for private chats and non-forum groups', async () => {
    const { env, keys } = makeTopicEnv();
    getSession.mockResolvedValueOnce({ username: 'alice', lastSessionId: 's-1' });
    await routeText({ chat: { id: 42, type: 'private' }, text: 'привет' }, env, 42);
    expect(keys).toEqual(['42']);
  });

  it('fails closed when the intake binding is absent instead of calling the legacy handler', async () => {
    const { env } = makeEnv();
    delete env.INTAKE;
    await routeText({ chat: { id: 42 }, text: 'не теряй меня' }, env, 42);
    expect(handleMessage).not.toHaveBeenCalled();
    expect(env.INTAKE).toBeUndefined();
    expect(sendMessage).toHaveBeenCalledWith('t', 42, expect.stringContaining('Не удалось сохранить'), {});
  });
});
