import { withUploads } from './helpers/uploads.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleMessage } from '../src/handlers/message.js';
import { handleCallbackQuery } from '../src/handlers/callbacks.js';
import { getSession, setSession } from '../src/lib/kv.js';
import { runTask, stopTask } from '../src/lib/agent-client.js';
import { sendMessage } from '../src/lib/telegram.js';

// ➕ Дополнить (sup|{taskId}): a running task can be interrupted with more
// context instead of only killed outright. Tap arms session.pendingSupplement;
// the next plain-text message stops the task and restarts the same session
// with that text folded in. Telegram mirror of trained-assist-web#33's
// Стоп/Дополнить pair — that PR's own notes flagged the Telegram side as a
// separate design problem (no composer to preview from), which this covers.
vi.mock('../src/lib/agent-client.js', async original => ({
  ...await original(), runTask: vi.fn().mockResolvedValue({}), stopTask: vi.fn().mockResolvedValue({ killed: 1 }),
}));
vi.mock('../src/lib/telegram.js', async original => ({
  ...await original(), sendMessage: vi.fn().mockResolvedValue({ result: { message_id: 50 } }),
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
  it('arms pendingSupplement on tap, then the next text message stops + restarts with it', async () => {
    await handleCallbackQuery({ id: 'cb-1', data: 'sup|task-abc', from: { id: chatId },
      message: { message_id: 200, chat: { id: chatId } } }, env);

    const armed = await getSession(env.SESSIONS, chatId);
    expect(armed.pendingSupplement).toMatchObject({ taskId: 'task-abc', sessionId: 's-1' });
    expect(sendMessage).toHaveBeenCalledWith('test', chatId, expect.stringContaining('Напиши текст'));

    await handleMessage(message('ещё учти вот это'), env, {});

    expect(stopTask).toHaveBeenCalledWith(env, { username: 'owner' });
    expect(runTask).toHaveBeenCalledTimes(1);
    const call = runTask.mock.calls[0][1];
    expect(call).toMatchObject({ sessionId: 's-1', forceClaude: true, mode: 'deep' });
    expect(call.task).toContain('ещё учти вот это');

    // One-shot: flag is consumed, a follow-up message behaves normally.
    expect((await getSession(env.SESSIONS, chatId)).pendingSupplement).toBeNull();
  });

  it('a stale (expired) flag is cleared and the message falls through to normal handling', async () => {
    await setSession(env.SESSIONS, chatId, { username: 'owner', activeSessionId: 's-1', lastSessionId: 's-1',
      pendingSupplement: { taskId: 'task-old', sessionId: 's-1', expiresAt: Date.now() - 1000 } });

    await handleMessage(message('обычное новое сообщение'), env, {});

    expect(stopTask).not.toHaveBeenCalled();
    expect((await getSession(env.SESSIONS, chatId)).pendingSupplement).toBeNull();
  });

  it('does not consume a batched/media message even with an armed flag', async () => {
    await setSession(env.SESSIONS, chatId, { username: 'owner', activeSessionId: 's-1', lastSessionId: 's-1',
      pendingSupplement: { taskId: 'task-abc', sessionId: 's-1', expiresAt: Date.now() + 60_000 } });

    await handleMessage({ ...message('caption'), intakeItems: [{ text: 'caption', msg: {} }] }, env, {});

    expect(stopTask).not.toHaveBeenCalled();
  });
});
