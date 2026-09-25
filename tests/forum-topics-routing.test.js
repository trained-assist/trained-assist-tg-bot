import { describe, it, expect, vi, beforeEach } from 'vitest';

// Forum-topic routing for the gateway's outbound paths (issue #255):
//  • IntakeBuffer sends carry message_thread_id
//  • callbacks flush the topic-keyed Durable Object
//  • routeText keys the DO by conversationKey(chatId, threadId)
// Regression matrix: text A → text B → flush A must never share one buffer.

const sendMessage = vi.fn(async () => ({ ok: true, result: { message_id: 1 } }));
const sendMessageWithKeyboard = vi.fn(async () => ({ ok: true, result: { message_id: 2 } }));
vi.mock('../src/lib/telegram.js', () => ({
  sendMessage: (...a) => sendMessage(...a),
  sendMessageWithKeyboard: (...a) => sendMessageWithKeyboard(...a),
  sendDocument: vi.fn(async () => ({ ok: true })),
  editMessage: vi.fn(async () => ({ ok: true })),
  editMessageReplyMarkup: vi.fn(async () => ({ ok: true })),
  deleteMessage: vi.fn(async () => ({ ok: true })),
  pinChatMessage: vi.fn(),
  unpinChatMessage: vi.fn(),
  answerCallbackQuery: vi.fn(async () => ({ ok: true })),
}));

const getSession = vi.fn(async () => ({ username: 'u', lastSessionId: 's-1' }));
vi.mock('../src/lib/kv.js', () => ({
  getSession: (...a) => getSession(...a),
  setSession: vi.fn(async () => {}),
  deleteSession: vi.fn(async () => {}),
  newSessionId: () => 's-new',
  withKvConsistencyRetry: async (_kv, _c, s) => s,
}));
vi.mock('../src/lib/agent-client.js', async original => ({
  ...await original(),
  runTask: vi.fn(async () => ({})),
  stopTask: vi.fn(async () => ({ killed: 1 })),
  getProjects: vi.fn(async () => []),
  getSessions: vi.fn(async () => []),
  readFile: vi.fn(async () => ({ content: '{}' })),
  archiveSessions: vi.fn(async () => ({ archived: 0 })),
  getProjectDecision: vi.fn(async () => ({ action: 'auto', choices: [] })),
}));
vi.mock('../src/lib/project-choice.js', () => ({
  openProjectChoice: vi.fn(async () => {}), chooseProject: vi.fn(async () => {}), startNewDialog: vi.fn(async () => {}),
}));

import { answerCallbackQuery, editMessageReplyMarkup } from '../src/lib/telegram.js';
import { IntakeBuffer } from '../src/intake-buffer.js';
import { handleCallbackQuery } from '../src/handlers/callbacks.js';

const CHAT = -1001234567890;

function makeIntakeEnv() {
  const captured = [];
  const map = new Map();
  const env = {
    BOT_TOKEN: 't',
    SESSIONS: {
      get: async k => map.get(k) ?? null,
      put: async (k, v) => { map.set(k, String(v)); },
      delete: async k => { map.delete(k); },
    },
    INTAKE: { idFromName: n => { captured.push(n); return n; }, get: () => ({ fetch: async () => Response.json({}) }) },
  };
  return { env, captured };
}

function makeDoState(initial = {}) {
  const store = { ...initial };
  const storage = {
    get: async k => store[k] ?? null,
    put: async (k, v) => { store[k] = v; },
    delete: async k => { delete store[k]; },
    setAlarm: async () => {},
    deleteAlarm: async () => {},
    getAlarm: async () => null,
    transaction: async fn => fn({ get: async k => store[k] ?? null, put: async (k, v) => { store[k] = v; }, delete: async k => { delete store[k]; }, setAlarm: async () => {} }),
    list: async () => new Map(),
  };
  return { state: { storage }, store };
}

beforeEach(() => vi.clearAllMocks());

describe('IntakeBuffer — outbound sends stay in the topic', () => {
  it('held notice carries message_thread_id for a forum topic', async () => {
    const { env } = makeIntakeEnv();
    const { state } = makeDoState({ busy: true, buf: [{ text: 'queued', msg: { chat: { id: CHAT }, message_id: 2, is_topic_message: true, message_thread_id: 9 } }] });
    const intake = new IntakeBuffer(state, env);
    await intake.fetch(new Request('https://intake/append', { method: 'POST', body: JSON.stringify({
      text: 'x', msg: { chat: { id: CHAT }, message_id: 3, text: 'x', is_topic_message: true, message_thread_id: 9 },
    }) }));
    await state.storage.put('receiptDue', Date.now() - 1); await intake.alarm();
    expect(sendMessageWithKeyboard).toHaveBeenCalledWith('t', CHAT, expect.any(String), expect.any(Array), expect.objectContaining({ message_thread_id: 9 }));
  });

  it('ordinary private-chat append never sends message_thread_id', async () => {
    const { env } = makeIntakeEnv();
    const { state } = makeDoState({ busy: true, buf: [{ text: 'queued', msg: { chat: { id: 42 }, message_id: 2, message_thread_id: 9 } }] });
    const intake = new IntakeBuffer(state, env);
    await intake.fetch(new Request('https://intake/append', { method: 'POST', body: JSON.stringify({
      text: 'x', msg: { chat: { id: 42 }, message_id: 3, text: 'x' },
    }) }));
    await state.storage.put('receiptDue', Date.now() - 1); await intake.alarm();
    const extra = sendMessageWithKeyboard.mock.calls[0][4];
    expect(extra).not.toHaveProperty('message_thread_id');
  });
});

describe('callbacks — topic-keyed flush', () => {
  it('flushes the DO for the callback message topic', async () => {
    const captured = [];
    const env = {
      BOT_TOKEN: 't', SESSIONS: {}, AGENT_URL: 'http://a', AGENT_SECRET: 's',
      INTAKE: { idFromName: n => { captured.push(n); return n; }, get: () => ({ fetch: async () => Response.json({ flushed: true }) }) },
    };
    await handleCallbackQuery({ id: 'c1', data: 'intake_run', from: { id: 999 },
      message: { chat: { id: CHAT }, message_id: 42, is_topic_message: true, message_thread_id: 77 } }, env);
    expect(captured).toEqual([`${CHAT}:77`]);
  });

  it('flushes the legacy chat DO when no thread', async () => {
    const captured = [];
    const env = {
      BOT_TOKEN: 't', SESSIONS: {}, AGENT_URL: 'http://a', AGENT_SECRET: 's',
      INTAKE: { idFromName: n => { captured.push(n); return n; }, get: () => ({ fetch: async () => Response.json({ flushed: true }) }) },
    };
    await handleCallbackQuery({ id: 'c2', data: 'intake_run', from: { id: 999 },
      message: { chat: { id: 999 }, message_id: 42 } }, env);
    expect(captured).toEqual(['999']);
  });
});

// A consumed accumulator is normal after launch, including delayed legacy taps.
describe('launch callback after the buffer was consumed', () => {
  it.each(['intake_run', 'workrun|old-session'])('%s acknowledges an empty flush without a chat message', async data => {
    const { env } = makeIntakeEnv();
    const { state } = makeDoState();
    const intake = new IntakeBuffer(state, env);
    env.INTAKE.get = () => ({ fetch: (url, init) => intake.fetch(new Request(url, init)) });
    for (const id of ['first', 'duplicate']) {
      await handleCallbackQuery({ id, data, from: { id: 999 },
        message: { chat: { id: CHAT }, message_id: 42, is_topic_message: true, message_thread_id: 77 } }, env);
    }
    expect(answerCallbackQuery).toHaveBeenCalledTimes(2);
    expect(editMessageReplyMarkup).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendMessageWithKeyboard).not.toHaveBeenCalled();
  });
});
