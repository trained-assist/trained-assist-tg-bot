import { withUploads } from './helpers/uploads.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleMessage } from '../src/handlers/message.js';
import { handleCallbackQuery } from '../src/handlers/callbacks.js';
import { getSession, setSession } from '../src/lib/kv.js';
import { runTask, stopTask } from '../src/lib/agent-client.js';
import { sendMessage, sendMessageWithKeyboard, editMessage, editMessageReplyMarkup } from '../src/lib/telegram.js';

// ➕ Дополнить (sup|{taskId}): a running task can be interrupted with more
// context instead of only killed outright — but never by a stray typed message.
// Flow: sup| arms session.pendingSupplementDraft → the next plain-text message is
// stashed as a DRAFT (message.js) and a ✅/❌ confirmation keyboard is shown →
// only the explicit supok| tap (callbacks.js) stops the task and restarts the same
// session with that text folded in. supno| cancels; expired drafts fall through.
// Telegram mirror of trained-assist-web#33's Стоп/Дополнить pair.
vi.mock('../src/lib/agent-client.js', async original => ({
  ...await original(), runTask: vi.fn().mockResolvedValue({}), stopTask: vi.fn().mockResolvedValue({ killed: 1 }),
}));
vi.mock('../src/lib/telegram.js', async original => ({
  ...await original(),
  sendMessage: vi.fn().mockResolvedValue({ result: { message_id: 50 } }),
  sendMessageWithKeyboard: vi.fn().mockResolvedValue({ result: { message_id: 51 } }),
  editMessage: vi.fn().mockResolvedValue({}),
  editMessageReplyMarkup: vi.fn().mockResolvedValue({}),
  answerCallbackQuery: vi.fn().mockResolvedValue({ ok: true }),
}));

let env, mid;
const chatId = 42;
const message = text => ({ message_id: ++mid, chat: { id: chatId, type: 'private' }, text });

beforeEach(async () => {
  vi.clearAllMocks(); mid = 100;
  const map = new Map();
  env = { BOT_TOKEN: 'test', SESSIONS: {
    get: async (key, opts) => opts?.type === 'json' ? JSON.parse(map.get(key) || 'null') : map.get(key),
    put: async (key, val) => map.set(key, val), delete: async key => map.delete(key),
  } };
  await setSession(env.SESSIONS, chatId, { username: 'owner', activeSessionId: 's-1', lastSessionId: 's-1', lastMessageAt: Date.now() });
  vi.stubGlobal('fetch', withUploads(async () => Response.json({ ok: true })));
});

describe('supplement a running task via ➕ Дополнить', () => {
  it('arms pendingSupplementDraft on tap; a typed message stashes a draft + asks for confirmation, does NOT stop anything', async () => {
    await handleCallbackQuery({ id: 'cb-1', data: 'sup|task-abc', from: { id: chatId },
      message: { message_id: 200, chat: { id: chatId } } }, env);

    const armed = await getSession(env.SESSIONS, chatId);
    expect(armed.pendingSupplementDraft).toMatchObject({ taskId: 'task-abc', sessionId: 's-1' });
    expect(sendMessage).toHaveBeenCalledWith('test', chatId, expect.stringContaining('Напиши текст'), expect.anything());

    await handleMessage(message('ещё учти вот это'), env, {});

    // No stop/restart on the bare text message — confirmation required first.
    expect(stopTask).not.toHaveBeenCalled();
    expect(runTask).not.toHaveBeenCalled();

    const draft = await getSession(env.SESSIONS, chatId);
    expect(draft.pendingSupplementDraft).toMatchObject({ taskId: 'task-abc', sessionId: 's-1', text: 'ещё учти вот это' });
    expect(sendMessageWithKeyboard).toHaveBeenCalledWith('test', chatId,
      expect.stringContaining('перезапустить её с твоим дополнением'),
      [[
        expect.objectContaining({ callback_data: 'supno|task-abc' }),
        expect.objectContaining({ callback_data: 'supok|task-abc' }),
      ]], {}, env);
  });

  it('supok| confirms: stops + restarts with the stashed text, then clears the draft', async () => {
    await handleCallbackQuery({ id: 'cb-1', data: 'sup|task-abc', from: { id: chatId },
      message: { message_id: 200, chat: { id: chatId } } }, env);
    await handleMessage(message('ещё учти вот это'), env, {});
    vi.clearAllMocks();

    await handleCallbackQuery({ id: 'cb-2', data: 'supok|task-abc', from: { id: chatId },
      message: { message_id: 201, chat: { id: chatId } } }, env);

    expect(stopTask).toHaveBeenCalledWith(env, expect.objectContaining({ username: 'owner' }));
    expect(runTask).toHaveBeenCalledTimes(1);
    const call = runTask.mock.calls[0][1];
    expect(call).toMatchObject({ sessionId: 's-1', forceClaude: true, mode: 'deep' });
    expect(call.task).toContain('ещё учти вот это');

    // One-shot: draft is consumed.
    expect((await getSession(env.SESSIONS, chatId)).pendingSupplementDraft).toBeNull();
  });

  it('supno| cancels: keeps the task alive, drops the draft', async () => {
    await handleCallbackQuery({ id: 'cb-1', data: 'sup|task-abc', from: { id: chatId },
      message: { message_id: 200, chat: { id: chatId } } }, env);
    await handleMessage(message('ещё учти вот это'), env, {});
    vi.clearAllMocks();

    await handleCallbackQuery({ id: 'cb-2', data: 'supno|task-abc', from: { id: chatId },
      message: { message_id: 201, chat: { id: chatId } } }, env);

    expect(stopTask).not.toHaveBeenCalled();
    expect(runTask).not.toHaveBeenCalled();
    expect((await getSession(env.SESSIONS, chatId)).pendingSupplementDraft).toBeNull();
  });

  it('a stale (expired) draft is cleared and the message falls through to normal handling', async () => {
    await setSession(env.SESSIONS, chatId, { username: 'owner', activeSessionId: 's-1', lastSessionId: 's-1',
      pendingSupplementDraft: { taskId: 'task-old', sessionId: 's-1', text: 'x', expiresAt: Date.now() - 1000 } });

    await handleMessage(message('обычное новое сообщение'), env, {});

    expect(stopTask).not.toHaveBeenCalled();
    expect((await getSession(env.SESSIONS, chatId)).pendingSupplementDraft).toBeNull();
  });

  it('a stale (expired) draft on supok| tap is dropped with a notice, no restart', async () => {
    await setSession(env.SESSIONS, chatId, { username: 'owner', activeSessionId: 's-1', lastSessionId: 's-1',
      pendingSupplementDraft: { taskId: 'task-old', sessionId: 's-1', text: 'x', expiresAt: Date.now() - 1000 } });

    await handleCallbackQuery({ id: 'cb-1', data: 'supok|task-old', from: { id: chatId },
      message: { message_id: 200, chat: { id: chatId } } }, env);

    expect(stopTask).not.toHaveBeenCalled();
    expect(runTask).not.toHaveBeenCalled();
    expect((await getSession(env.SESSIONS, chatId)).pendingSupplementDraft).toBeNull();
  });

  it('does not consume a batched/media message even with an armed draft', async () => {
    await setSession(env.SESSIONS, chatId, { username: 'owner', activeSessionId: 's-1', lastSessionId: 's-1',
      pendingSupplementDraft: { taskId: 'task-abc', sessionId: 's-1', expiresAt: Date.now() + 60_000 } });

    await handleMessage({ ...message('caption'), intakeItems: [{ text: 'caption', msg: {} }] }, env, {});

    expect(stopTask).not.toHaveBeenCalled();
  });
});
