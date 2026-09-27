import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleMessage } from '../src/handlers/message.js';
import { getSession, setSession } from '../src/lib/kv.js';
import { runTask } from '../src/lib/agent-client.js';
import { sendMessage } from '../src/lib/telegram.js';

// Defense-in-depth for the 2026-09-27 incident (group addressed empty task →
// agent 400 "missing fields"): even if a content-less message slips past the
// router gates (e.g. some future caller), handleMessage itself must NEVER
// dispatch an empty task. Lock: a message with no text/caption/media/fileRefs
// is dropped before runTask, and no placeholder is sent.
vi.mock('../src/lib/agent-client.js', async original => ({
  ...await original(), runTask: vi.fn().mockResolvedValue({}),
}));
vi.mock('../src/lib/telegram.js', async original => ({
  ...await original(),
  sendMessage: vi.fn().mockResolvedValue({ result: { message_id: 50 } }),
  sendMessageWithKeyboard: vi.fn().mockResolvedValue({ result: { message_id: 51 } }),
}));

let env, mid;
const chatId = 42;

beforeEach(async () => {
  vi.clearAllMocks(); mid = 100;
  const map = new Map();
  env = { BOT_TOKEN: 'test', SESSIONS: {
    get: async (key, opts) => opts?.type === 'json' ? JSON.parse(map.get(key) || 'null') : map.get(key),
    put: async (key, val) => map.set(key, val), delete: async key => map.delete(key),
  } };
  await setSession(env.SESSIONS, chatId, { username: 'owner', lastSessionId: 's-1', lastMessageAt: Date.now() });
  vi.stubGlobal('fetch', async () => Response.json({ ok: true }));
});

describe('handleMessage — content-less message', () => {
  it('a sticker (no text/caption/file) is dropped, runTask never called, no placeholder sent', async () => {
    await handleMessage({ message_id: ++mid, chat: { id: chatId, type: 'private' }, sticker: { file_id: 's1' } }, env, {});
    expect(runTask).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('a real text message still dispatches as before', async () => {
    await handleMessage({ message_id: ++mid, chat: { id: chatId, type: 'private' }, text: 'сделай отчёт' }, env, {});
    expect(runTask).toHaveBeenCalledTimes(1);
  });

  it('a buffered launch (intakeItems) is not affected by the guard', async () => {
    await handleMessage({ message_id: ++mid, chat: { id: chatId, type: 'private' },
      intakeItems: [{ text: 'собери участников', msg: {} }] }, env, {});
    expect(runTask).toHaveBeenCalledTimes(1);
  });
});