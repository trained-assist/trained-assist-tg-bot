import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleCallbackQuery } from '../src/handlers/callbacks.js';
import { openProjectChoice } from '../src/lib/project-choice.js';
import { getSession, setSession } from '../src/lib/kv.js';
import { runTask } from '../src/lib/agent-client.js';
import { answerCallbackQuery } from '../src/lib/telegram.js';

vi.mock('../src/lib/agent-client.js', async o => ({ ...await o(), getProjectDecision: vi.fn(), runTask: vi.fn().mockResolvedValue({}) }));
vi.mock('../src/lib/telegram.js', async o => ({ ...await o(),
  sendMessage: vi.fn().mockResolvedValue({ result: { message_id: 50 } }),
  sendMessageWithKeyboard: vi.fn(), editMessage: vi.fn().mockResolvedValue({ ok: true }),
  answerCallbackQuery: vi.fn().mockResolvedValue({ ok: true }) }));
import { sendMessageWithKeyboard } from '../src/lib/telegram.js';

// Regression (owner, 2026-09-24): in a group the picker is opened by the IntakeBuffer
// DO; the webhook colo handling the tap still read the previous picker from KV, the
// tap was rejected as «Меню устарело» and the captured task never launched.
const chatId = -100500;
const projects = [{ id: 'p0', name: 'Project 0' }, { id: 'p1', name: 'Project 1' }];
let env, kv, doStore;
const tap = (data, messageId) => handleCallbackQuery({ id: `cb-${messageId}-${data}`, data, from: { id: 1 },
  message: { message_id: messageId, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'supergroup' } } }, env);

beforeEach(async () => {
  vi.clearAllMocks();
  kv = new Map(); doStore = new Map();
  const SESSIONS = { get: async (k, o) => o?.type === 'json' ? JSON.parse(kv.get(k) || 'null') : (kv.get(k) ?? null),
    put: async (k, v) => kv.set(k, v), delete: async k => kv.delete(k), list: async () => ({ keys: [] }) };
  const INTAKE = { idFromName: n => n, get: () => ({ fetch: async (url, init = {}) => {
    if (new URL(url).pathname !== '/picker') return Response.json({ ok: true });
    if ((init.method || 'GET') === 'PUT') { const { pending } = JSON.parse(init.body); pending ? doStore.set('picker', pending) : doStore.delete('picker'); return Response.json({ ok: true }); }
    return Response.json({ pending: doStore.get('picker') || null });
  } }) };
  env = { BOT_TOKEN: 't', SESSIONS, INTAKE };
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, result: { message_id: 5 } })));
  sendMessageWithKeyboard.mockResolvedValueOnce({ result: { message_id: 660 } });
  await setSession(SESSIONS, chatId, { username: 'u', lastSessionId: 'old' });
  const input = { message_id: 658, chat: { id: chatId, type: 'supergroup' }, text: 'Запускай' };
  await openProjectChoice(env, chatId, await getSession(SESSIONS, chatId), { decision: { action: 'ask', choices: projects }, input });
});

describe('project picker tap when SESSIONS KV is stale', () => {
  it('launches the captured task from the DO mirror although KV still shows an older picker', async () => {
    const fresh = await getSession(env.SESSIONS, chatId);
    // Simulate the stale colo: KV still holds the previous picker (message 657).
    await setSession(env.SESSIONS, chatId, { ...fresh, pendingProjectChoice: { ...fresh.pendingProjectChoice, messageId: 657, token: 'old' } });
    await tap('pc:1', 660);
    expect(runTask).toHaveBeenCalledTimes(1);
    expect(runTask.mock.calls[0][1]).toMatchObject({ projectId: 'p1', projectPicked: true, forceNew: true });
    expect(doStore.has('picker')).toBe(false);
  });
  it('a second tap on the same picker does not launch the task twice', async () => {
    await tap('pc:1', 660);
    await tap('pc:0', 660);
    expect(runTask).toHaveBeenCalledTimes(1);
  });
  it('a genuinely old picker message is still rejected', async () => {
    await tap('pc:0', 600);
    expect(runTask).not.toHaveBeenCalled();
  });
});
