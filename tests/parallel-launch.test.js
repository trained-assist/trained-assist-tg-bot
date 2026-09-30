import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleMessage } from '../src/handlers/message.js';
import { getSession, setSession } from '../src/lib/kv.js';
import { getProjectDecision, runTask, getSessions, classifyMessage } from '../src/lib/agent-client.js';
import { sendMessage, sendMessageWithKeyboard } from '../src/lib/telegram.js';

vi.mock('../src/lib/agent-client.js', async original => ({
  ...await original(), getProjectDecision: vi.fn(), getSessions: vi.fn(), classifyMessage: vi.fn(), runTask: vi.fn().mockResolvedValue({}),
}));
vi.mock('../src/lib/telegram.js', async original => ({
  ...await original(), sendMessage: vi.fn().mockResolvedValue({ result: { message_id: 50 } }),
  sendMessageWithKeyboard: vi.fn().mockResolvedValue({ result: { message_id: 51 } }),
  editMessage: vi.fn().mockResolvedValue({ ok: true }),
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
  getProjectDecision.mockResolvedValue({ action: 'ask', choices: [{ id: 'p0', name: 'Project 0' }, { id: 'p1', name: 'Project 1' }] });
  getSessions.mockResolvedValue([{ id: 'old', projectId: 'pinned', lastAt: Date.now() }]);
  classifyMessage.mockResolvedValue({ confidence: 'high', sessionId: 'old' });
  await setSession(env.SESSIONS, chatId, { username: 'owner', lastSessionId: 'old', activeSessionId: 'old', lastMessageAt: Date.now(), projectId: 'pinned' });
});

// RC-03 (trained-agent-architecture): «⚡ Параллельно» — the held batch launches
// as its OWN fresh session (never the one run A is writing to), without stopping
// for the project picker mid-run, and the /run payload carries the parallel flag
// the agent's admission uses to skip only the dialog lane.
describe('parallel launch route (RC-03)', () => {
  it('opts.parallel → fresh session, forceNew, parallel flag, no picker', async () => {
    await handleMessage(message('параллельная задача'), env, { mode: 'deep', parallel: true });

    expect(getProjectDecision).not.toHaveBeenCalled(); // picker skipped mid-run
    expect(runTask).toHaveBeenCalledTimes(1);
    const payload = runTask.mock.calls[0][1];
    expect(payload).toMatchObject({ parallel: true, forceNew: true, mode: 'deep', projectId: 'pinned', projectPicked: false });
    expect(payload.sessionId).toBeTruthy();
    expect(payload.sessionId).not.toBe('old'); // own session — never A's history
  });

  it('without the flag nothing changes: continuation keeps the current session', async () => {
    await handleMessage(message('обычное продолжение'), env, { mode: 'deep' });
    const payload = runTask.mock.calls[0][1];
    expect(payload.parallel).toBe(false);
    expect(payload.sessionId).toBe('old');
    expect(payload.forceNew).toBe(false);
  });
});
