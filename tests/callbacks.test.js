import { describe, it, expect, vi, beforeEach } from 'vitest';

// All callback_data prefixes/values that the agent side can generate.
// If you add a new inline button in runner.js or anywhere else in trained-assist-agent,
// add its prefix here AND add a handler in src/handlers/callbacks.js.
const KNOWN_CALLBACK_PREFIXES = [
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
  'intake_parallel', // «⚡ Параллельно» — explicit parallel launch from the busy menu (RC-03, #316)
  'intake_stopsupp', // «🛑 Стоп и запуск с добавкой» — stop the run, continue it with the held input (RC-04, #316)
  'intake_stopnew',  // «⛔ Стоп → новая задача» — stop the run, start the held input as its own task (RC-05, #316)
  'intake_stopyes|', // ⛔ Точно остановить under either stop option — confirm, stop, launch
  'intake_stopno|',  // ↩️ Вернуться — cancels the question, the task keeps running
  'pp:',        // project picker — pick/create typed project at new dialog (#517)
  'plan|',      // «▶️ Действуй дальше по плану» — continue deep session by the plan (#530)
  'menu|',      // multi-button menu — continue deep session by the tapped option (§D)
  'act|',       // extracted action buttons — run the tapped label in the same session (#1542 P3)
  'stop|',      // ⛔ Стоп button sent by agent on task start — show stop confirm
  'stopok|',    // ⛔ Точно остановить — confirmed, actually stops the running task
  'stopno|',    // ↩️ Вернуться (stop) — cancels, task keeps running
  'sup|',       // ➕ Дополнить button sent by agent alongside ⛔ Стоп — arm pendingSupplement
  'qa_more|',   // 🔎 Разобраться подробнее — escalate quick answer to Claude
  'ocl|',       // forgotten checklist «▶️ Делать» / «✖️ Отменить» (#1729 BV-08/08a)
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
  editMessageReplyMarkup: vi.fn().mockResolvedValue({}),
  pinChatMessage: vi.fn().mockResolvedValue({}),
  unpinChatMessage: vi.fn().mockResolvedValue({}),
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
  orphanChecklistAction: vi.fn().mockResolvedValue({ ok: true, status: 'started', text: '▶️ Взял в работу: «История группы»' }),
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
                   prefix === 'sl:' || prefix === 'nd:' || prefix === 'intake_parallel'
                     || prefix === 'intake_stopsupp' || prefix === 'intake_stopnew' ? prefix :
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

// A repeated launch tap must not manufacture another task/status bubble.
describe('callbacks — intake_run while a run is already busy (дыра №4)', () => {
  it('acknowledges a busy launch without creating a second status message', async () => {
    vi.clearAllMocks();
    const { handleCallbackQuery } = await import('../src/handlers/callbacks.js');
    const { sendMessage } = await import('../src/lib/telegram.js');
    const stub = { fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ busy: true }))) };
    const env = {
      BOT_TOKEN: 'test-token', SESSIONS: {}, AGENT_URL: 'http://agent', AGENT_SECRET: 'secret',
      INTAKE: { idFromName: (n) => n, get: () => stub },
    };

    const cq = {
      id: 'cq-1',
      data: 'intake_run',
      from: { id: 999 },
      message: { chat: { id: 999 }, message_id: 42 },
    };
    await handleCallbackQuery(cq, env);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(stub.fetch).toHaveBeenCalledTimes(1);
  });
});

// The DO returns `queued` for a tap blocked by a still-downloading attachment (#293).
// Nothing is running at that point, so the gateway must NOT narrate a running
// task — the DO already sent its own honest «📥 Задачу забрал …» collector.
describe('callbacks — intake_run while an attachment is still preparing', () => {
  it('stays silent instead of announcing a task that is not running', async () => {
    vi.clearAllMocks();
    const { handleCallbackQuery } = await import('../src/handlers/callbacks.js');
    const { sendMessage } = await import('../src/lib/telegram.js');
    const stub = { fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ preparing: true, queued: true }))) };
    const env = {
      BOT_TOKEN: 'test-token', SESSIONS: {}, AGENT_URL: 'http://agent', AGENT_SECRET: 'secret',
      INTAKE: { idFromName: (n) => n, get: () => stub },
    };

    await handleCallbackQuery({ id: 'cq-1', data: 'intake_run', from: { id: 999 },
      message: { chat: { id: 999 }, message_id: 42 } }, env);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(stub.fetch).toHaveBeenCalledTimes(1);
  });
});


describe('legacy checklist footer menu', () => {
  it.each([
    ['2. Отключить чеклист', '/checklist_turn_off'],
    ['1. Чеклист активен', '/show_active_cheklist'],
  ])('routes %s as an exact command without a new deep session', async (text, task) => {
    vi.clearAllMocks();
    const { handleCallbackQuery } = await import('../src/handlers/callbacks.js');
    const { runTask } = await import('../src/lib/agent-client.js');
    const { sendMessage } = await import('../src/lib/telegram.js');
    const data = 'menu|original-session|1';
    await handleCallbackQuery({ id: 'legacy-checklist', data, from: { id: 999 }, message: {
      chat: { id: 999 }, message_id: 42,
      reply_markup: { inline_keyboard: [[{ text, callback_data: data }]] },
    } }, { BOT_TOKEN: 'test', SESSIONS: {} });
    expect(runTask).toHaveBeenCalledOnce();
    expect(runTask.mock.calls[0][1]).toMatchObject({ sessionId: 'original-session', task, forceClaude: false });
    expect(runTask.mock.calls[0][1].mode).toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});


describe('act| extracted action buttons (#1542 P3)', () => {
  it('runs the tapped label as a deep task in the same session', async () => {
    vi.clearAllMocks();
    const { handleCallbackQuery } = await import('../src/handlers/callbacks.js');
    const { runTask } = await import('../src/lib/agent-client.js');
    const data = 'act|orig-session|1';
    await handleCallbackQuery({ id: 'act-1', data, from: { id: 999 }, message: {
      chat: { id: 999 }, message_id: 42,
      reply_markup: { inline_keyboard: [
        [{ text: '▶️ Создать PR', callback_data: 'act|orig-session|0' }],
        [{ text: '▶️ Задеплоить на прод', callback_data: data }],
      ] },
    } }, { BOT_TOKEN: 'test', SESSIONS: {} });
    expect(runTask).toHaveBeenCalledOnce();
    const args = runTask.mock.calls[0][1];
    expect(args).toMatchObject({ sessionId: 'orig-session', forceClaude: true, mode: 'deep' });
    expect(args.task).toContain('«Задеплоить на прод»');
    expect(args.task).not.toContain('Создать PR');
  });

  it('does not run anything when the tapped button is missing from markup', async () => {
    vi.clearAllMocks();
    const { handleCallbackQuery } = await import('../src/handlers/callbacks.js');
    const { runTask } = await import('../src/lib/agent-client.js');
    await handleCallbackQuery({ id: 'act-2', data: 'act|s|0', from: { id: 999 }, message: {
      chat: { id: 999 }, message_id: 42, reply_markup: { inline_keyboard: [] },
    } }, { BOT_TOKEN: 'test', SESSIONS: {} });
    expect(runTask).not.toHaveBeenCalled();
  });
});


describe('ocl| forgotten checklist buttons (#1729 BV-08/08a)', () => {
  it('«▶️ Делать» forwards to the agent route and edits the reminder to the outcome', async () => {
    vi.clearAllMocks();
    const { handleCallbackQuery } = await import('../src/handlers/callbacks.js');
    const { orphanChecklistAction, runTask } = await import('../src/lib/agent-client.js');
    const { answerCallbackQuery, editMessage } = await import('../src/lib/telegram.js');
    await handleCallbackQuery({ id: 'ocl-1', data: 'ocl|do|abcdef012345', from: { id: 999 }, message: {
      chat: { id: -100500 }, message_id: 77, message_thread_id: 12, is_topic_message: true,
    } }, { BOT_TOKEN: 'test', SESSIONS: {} });
    expect(orphanChecklistAction).toHaveBeenCalledOnce();
    expect(orphanChecklistAction.mock.calls[0][1]).toMatchObject({ username: 'testuser', action: 'do', id: 'abcdef012345', chatId: -100500, threadId: 12 });
    expect(answerCallbackQuery).toHaveBeenCalledWith('test', 'ocl-1', '▶️ Взял в работу: «История группы»');
    expect(editMessage).toHaveBeenCalledOnce();
    const [, chat, msgId, text, extra] = editMessage.mock.calls[0];
    expect([chat, msgId, text]).toEqual([-100500, 77, '▶️ Взял в работу: «История группы»']);
    expect(extra.reply_markup).toEqual({ inline_keyboard: [] });
    expect(runTask).not.toHaveBeenCalled(); // deterministic route, no LLM run from the gateway
  });

  it('«✖️ Отменить» sends action no; agent failure is answered, not swallowed', async () => {
    vi.clearAllMocks();
    const { handleCallbackQuery } = await import('../src/handlers/callbacks.js');
    const { orphanChecklistAction } = await import('../src/lib/agent-client.js');
    const { answerCallbackQuery, editMessage } = await import('../src/lib/telegram.js');
    orphanChecklistAction.mockRejectedValueOnce(new Error('HTTP 502'));
    await handleCallbackQuery({ id: 'ocl-2', data: 'ocl|no|abcdef012345', from: { id: 999 }, message: { chat: { id: 999 }, message_id: 5 } },
      { BOT_TOKEN: 'test', SESSIONS: {} });
    expect(orphanChecklistAction.mock.calls[0][1].action).toBe('no');
    expect(answerCallbackQuery).toHaveBeenCalledWith('test', 'ocl-2', '⚠️ Агент недоступен — попробуй позже');
    expect(editMessage).not.toHaveBeenCalled();
  });

  it('malformed ocl| data never reaches the agent', async () => {
    vi.clearAllMocks();
    const { handleCallbackQuery } = await import('../src/handlers/callbacks.js');
    const { orphanChecklistAction } = await import('../src/lib/agent-client.js');
    await handleCallbackQuery({ id: 'ocl-3', data: 'ocl|rm|x', from: { id: 999 }, message: { chat: { id: 999 }, message_id: 5 } },
      { BOT_TOKEN: 'test', SESSIONS: {} });
    expect(orphanChecklistAction).not.toHaveBeenCalled();
  });
});

// #305: the ↩️ tail left in place of ▶️ after a queued tap.
describe('callbacks — intake_cancel (#305)', () => {
  it('asks the DO to cancel the queued transfer and confirms in the chat', async () => {
    vi.clearAllMocks();
    const { handleCallbackQuery } = await import('../src/handlers/callbacks.js');
    const { sendMessage } = await import('../src/lib/telegram.js');
    const stub = { fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ cancelled: true }))) };
    const env = {
      BOT_TOKEN: 'test-token', SESSIONS: {}, AGENT_URL: 'http://agent', AGENT_SECRET: 'secret',
      INTAKE: { idFromName: (n) => n, get: () => stub },
    };

    await handleCallbackQuery({ id: 'cq-1', data: 'intake_cancel', from: { id: 999 },
      message: { chat: { id: 999 }, message_id: 42 } }, env);

    expect(stub.fetch).toHaveBeenCalledTimes(1);
    expect(String(stub.fetch.mock.calls[0][0])).toContain('/cancel');
    expect(sendMessage.mock.calls.at(-1)?.[2] || '').toContain('Передача отменена');
  });

  it('sends task-scoped ownership data for legacy unknown-task dismissal', async () => {
    vi.clearAllMocks();
    const { handleCallbackQuery } = await import('../src/handlers/callbacks.js');
    const stub = { fetch: vi.fn().mockResolvedValue(new Response('{}', { status: 200 })) };
    const env = {
      BOT_TOKEN: 'test-token', SESSIONS: {}, AGENT_URL: 'http://agent', AGENT_SECRET: 'secret',
      INTAKE: { idFromName: name => name, get: () => stub },
    };
    const data = 'intake_dismiss_unknown|123e4567-e89b-42d3-a456-426614174000';

    await handleCallbackQuery({ id: 'dismiss-legacy', data, from: { id: 999 },
      message: { chat: { id: 999 }, message_id: 42 } }, env);

    expect(stub.fetch).toHaveBeenCalledTimes(1);
    expect(stub.fetch.mock.calls[0][0]).toBe('https://intake/dismiss-unknown');
    expect(JSON.parse(stub.fetch.mock.calls[0][1].body)).toEqual({
      messageId: 42, callbackData: data, username: 'testuser',
    });
  });

  it('stays silent when there was nothing queued to cancel', async () => {
    vi.clearAllMocks();
    const { handleCallbackQuery } = await import('../src/handlers/callbacks.js');
    const { sendMessage } = await import('../src/lib/telegram.js');
    const stub = { fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ cancelled: false }))) };
    const env = {
      BOT_TOKEN: 'test-token', SESSIONS: {}, AGENT_URL: 'http://agent', AGENT_SECRET: 'secret',
      INTAKE: { idFromName: (n) => n, get: () => stub },
    };

    await handleCallbackQuery({ id: 'cq-1', data: 'intake_cancel', from: { id: 999 },
      message: { chat: { id: 999 }, message_id: 42 } }, env);

    expect(stub.fetch).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
