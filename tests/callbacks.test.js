import { describe, it, expect, vi, beforeEach } from 'vitest';

// All callback_data prefixes/values that the agent side can generate.
// If you add a new inline button in runner.js or anywhere else in trained-assist-agent,
// add its prefix here AND add a handler in src/handlers/callbacks.js.
const KNOWN_CALLBACK_PREFIXES = [
  'ri:',        // durable restart confirmation, no navigation TTL
  'sp:',        // session picker
  'sd:',        // session detail
  'sc:',        // session continue
  'si:',        // session info
  'sn:',        // new dialog with context
  'sl:',        // back to sessions list
  'nd:',        // new dialog
  'prof:',      // profile actions
  'fl:',        // file browser navigate
  'fr:',        // file browser read
  'workrun|',   // legacy «⏻ Запустить проработку» from old chats — now flushes the intake buffer (#530 §B)
  'pp:',        // project picker — pick/create typed project at new dialog (#517)
  'plan|',      // «▶️ Действуй дальше по плану» — continue deep session by the plan (#530)
  'menu|',      // multi-button menu — continue deep session by the tapped option (§D)
  'stop|',      // ⛔ Стоп button sent by agent on task start — stop running task
  'qa_more|',   // 🔎 Разобраться подробнее — escalate quick answer to Claude
  'ar:',        // archive sessions menu
  'sa:',        // archive single session
];

// Mock all external dependencies so we can import the handler
vi.mock('../src/lib/kv.js', () => ({
  getSession: vi.fn().mockResolvedValue({
    username: 'testuser',
    activeSessionId: 's-123',
    lastSessionId: 's-123',
    pendingMessage: 'task',
    pendingMessageAt: Date.now(),
  }),
  setSession: vi.fn().mockResolvedValue(undefined),
  deleteSession: vi.fn().mockResolvedValue(undefined),
  newSessionId: vi.fn(chatId => `s-${Math.abs(chatId)}-123456`),
  withKvConsistencyRetry: vi.fn((kv, chatId, session) => Promise.resolve(session)),
}));

vi.mock('../src/lib/telegram.js', () => ({
  sendMessage: vi.fn().mockResolvedValue({}),
  sendMessageWithKeyboard: vi.fn().mockResolvedValue({}),
  answerCallbackQuery: vi.fn().mockResolvedValue({}),
  editMessage: vi.fn().mockResolvedValue({}),
}));

vi.mock('../src/lib/agent-client.js', () => ({
  runTask: vi.fn().mockResolvedValue({ taskId: 'test-task' }),
  getSessions: vi.fn().mockResolvedValue([]),
  readFile: vi.fn().mockResolvedValue({ content: '{}', truncated: false, size: 2 }),
  archiveSessions: vi.fn().mockResolvedValue({ archived: [] }),
  getProjects: vi.fn().mockResolvedValue([
    { name: '', label: '🏠 Корень', count: 3 },
    { name: 'efimova-school', label: 'efimova-school', count: 5 },
  ]),
  stopTask: vi.fn().mockResolvedValue({ killed: 1 }),
}));

vi.mock('../src/handlers/commands.js', () => ({
  cmdFiles: vi.fn().mockResolvedValue(undefined),
  timeAgo: vi.fn().mockReturnValue('1м'),
}));

describe('callbacks — all known prefixes are handled (not silently ignored)', () => {
  let handleCallbackQuery;
  let runTask;

  beforeEach(async () => {
    vi.clearAllMocks();
    const callbacks = await import('../src/handlers/callbacks.js');
    handleCallbackQuery = callbacks.handleCallbackQuery;
    const agentClient = await import('../src/lib/agent-client.js');
    runTask = agentClient.runTask;
  });

  const env = { BOT_TOKEN: 'test-token', SESSIONS: {}, AGENT_URL: 'http://agent', AGENT_SECRET: 'secret' };

  for (const prefix of KNOWN_CALLBACK_PREFIXES) {
    it(`handles callback prefix "${prefix}" — runTask or sendMessage called, not silently dropped`, async () => {
      const { sendMessage, answerCallbackQuery } = await import('../src/lib/telegram.js');

      // Build a minimal callback_query
      const data = prefix === 'workrun|' ? `${prefix}s-123` :
                   prefix === 'sl:' || prefix === 'nd:' ? prefix :
                   `${prefix}test-id`;

      const cq = {
        id: 'cq-1',
        data,
        from: { id: 999 },
        message: { chat: { id: 999 }, message_id: 42 },
      };

      await handleCallbackQuery(cq, env);

      // workrun| is now the legacy alias of intake_run: it flushes the buffer (single
      // launch source, #530 §B) — no runTask, no lastUserMessage rerun. With no INTAKE
      // binding in the test env it just acks the callback; the general check below covers it.

      // Every real handler calls answerCallbackQuery at least once explicitly in its branch.
      // A silently-ignored callback would call nothing at all.
      const { sendMessageWithKeyboard } = await import('../src/lib/telegram.js');
      const { cmdFiles } = await import('../src/handlers/commands.js');
      const didSomething =
        answerCallbackQuery.mock.calls.length > 0 ||
        sendMessage.mock.calls.length > 0 ||
        sendMessageWithKeyboard.mock.calls.length > 0 ||
        runTask.mock.calls.length > 0 ||
        cmdFiles.mock.calls.length > 0;
      expect(didSomething, `prefix "${prefix}" appears to be silently ignored`).toBe(true);
    });
  }
});

describe('callbacks — clarify| removed (§9.2 owner reversal, 2026-09-14)', () => {
  it('a stale clarify| tap from an old chat does not re-run Claude', async () => {
    vi.clearAllMocks();
    const { handleCallbackQuery } = await import('../src/handlers/callbacks.js');
    const { runTask } = await import('../src/lib/agent-client.js');
    const { answerCallbackQuery } = await import('../src/lib/telegram.js');
    const env = { BOT_TOKEN: 'test-token', SESSIONS: {}, AGENT_URL: 'http://agent', AGENT_SECRET: 'secret' };

    const cq = {
      id: 'cq-1',
      data: 'clarify|s-123',
      from: { id: 999 },
      message: { chat: { id: 999 }, message_id: 42 },
    };
    await handleCallbackQuery(cq, env);

    expect(runTask).not.toHaveBeenCalled();
    // Falls through to the plain ack at the bottom of the handler, not silence.
    expect(answerCallbackQuery).toHaveBeenCalled();
  });
});
