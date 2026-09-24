import { describe, it, expect, vi, beforeEach } from 'vitest';

// Automatic ambiguity resolves projects, never dialog menus.

const runTask = vi.fn();
const getProjectDecision = vi.fn();
const getSessions = vi.fn();
const classifyMessage = vi.fn();
const classifyAgentError = vi.fn();
const sendMessage = vi.fn();
const sendMessageWithKeyboard = vi.fn();
const setSession = vi.fn();
const getSession = vi.fn();

vi.mock('../src/lib/agent-client.js', () => ({
  runTask: (...a) => runTask(...a),
  getSessions: (...a) => getSessions(...a),
  classifyMessage: (...a) => classifyMessage(...a),
  getProjectDecision: (...a) => getProjectDecision(...a),
  classifyAgentError: (...a) => classifyAgentError(...a),
  pickAgentUrl: vi.fn(async () => 'http://agent'),
}));
vi.mock('../src/lib/kv.js', () => ({
  getSession: (...a) => getSession(...a),
  setSession: (...a) => setSession(...a),
  newSessionId: (chatId) => `s-${Math.abs(chatId)}-new`,
  scheduleRetry: vi.fn(),
  takeDueRetries: vi.fn(async () => []),
  markRetryStarted: vi.fn(),
  finishRetry: vi.fn(),
  saveRetryOutcome: vi.fn(),
}));
vi.mock('../src/lib/telegram.js', () => ({
  sendMessage: (...a) => sendMessage(...a),
  sendDocument: vi.fn(),
  sendMessageWithKeyboard: (...a) => sendMessageWithKeyboard(...a),
  editMessage: vi.fn(),
  editMessageReplyMarkup: vi.fn(),
}));
vi.mock('../src/handlers/commands.js', () => ({
  renderSessionList: () => ({ text: 'pick', buttons: [] }),
  escHtml: (s) => s,
  timeAgo: () => '1д',
}));
vi.mock('../src/intake-preflight.js', () => ({
  preflight: vi.fn(async (msg) => ({ msg })),
  prepareIntake: vi.fn(async (msg) => msg),
}));
vi.mock('../src/intake-routing.js', () => ({
  shouldDebounce: () => false,
  shouldAskProject: ({ decision }) => decision?.action === 'ask',
  FORCE_RUN_RE: /^never$/,
  hasIntakeContent: () => true,
  coalesceItem: (i) => i?.text || '',
  coalesceBuffer: (buf) => buf.map(i => i?.text || '').join('\n'),
}));
vi.mock('../src/lib/project-choice.js', () => ({
  openProjectChoice: vi.fn(),
  projectChoiceExpired: vi.fn(() => false),
}));

import { openProjectChoice } from '../src/lib/project-choice.js';
import { handleMessage } from '../src/handlers/message.js';

const CHAT_ID = 42;
const THREE_HOURS_AGO = Date.now() - 3 * 60 * 60 * 1000; // 3h ago → old session (well past 1h threshold)
const TWO_HOURS_AGO = THREE_HOURS_AGO; // alias kept for existing tests
const NINETY_MIN_AGO = Date.now() - 90 * 60 * 1000; // 1.5h ago → also past new 1h threshold

// Two sessions → classifier would normally be invoked.
const TWO_SESSIONS = [
  { id: 's-42-1', topic: 'холодный поиск', lastAt: THREE_HOURS_AGO },
  { id: 's-42-2', topic: 'установка вакансии', lastAt: THREE_HOURS_AGO - 1000 },
];

const env = { BOT_TOKEN: 't', SESSIONS: {} };

beforeEach(() => {
  vi.clearAllMocks();
  sendMessage.mockResolvedValue({ ok: true, result: { message_id: 10 } });
  sendMessageWithKeyboard.mockResolvedValue({ ok: true, result: { message_id: 11 } });
  setSession.mockResolvedValue();
  runTask.mockResolvedValue({ ok: true });
  getProjectDecision.mockResolvedValue({ action: 'auto' });
  classifyMessage.mockResolvedValue({ sessionId: null, confidence: 'low' });
  getSessions.mockResolvedValue(TWO_SESSIONS);
  getSession.mockResolvedValue({
    username: 'u',
    lastSessionId: 's-42-1',
    lastMessageAt: TWO_HOURS_AGO,
  });
});

describe('resolveSessionRoute — R-slash-nopicker: slash commands skip disambiguation', () => {
  it('does not show session picker for a slash command when last session is old', async () => {
    await handleMessage({ chat: { id: CHAT_ID }, text: '/hh_ats', message_id: 1, date: Math.floor(Date.now() / 1000) }, env);

    expect(sendMessageWithKeyboard).not.toHaveBeenCalled();
    expect(getSessions).not.toHaveBeenCalled(); // never fetches sessions list for a command
    expect(runTask).toHaveBeenCalledTimes(1);
    const call = runTask.mock.calls[0][1]; // (env, payload)
    expect(call.task).toBe('/hh_ats');
    expect(call.sessionId).toBe('s-42-1'); // continues the last session
  });

  it('routes /hh_scan to last session without classify round-trip', async () => {
    await handleMessage({ chat: { id: CHAT_ID }, text: '/hh_scan', message_id: 2, date: Math.floor(Date.now() / 1000) }, env);

    expect(classifyMessage).not.toHaveBeenCalled();
    expect(sendMessageWithKeyboard).not.toHaveBeenCalled();
    expect(runTask).toHaveBeenCalledOnce();
  });
});

describe('resolveSessionRoute — 1h threshold: sessions 1-2h old now trigger classify', () => {
  it('calls classify for a session 90 min old (was auto-continued under old 2h threshold)', async () => {
    classifyMessage.mockResolvedValue({ sessionId: null, confidence: 'low' });
    getSession.mockResolvedValue({
      username: 'u',
      lastSessionId: 's-42-1',
      lastMessageAt: NINETY_MIN_AGO,
    });

    await handleMessage({ chat: { id: CHAT_ID }, text: 'расскажи про DS встречу', message_id: 4, date: Math.floor(Date.now() / 1000) }, env);

    expect(classifyMessage).toHaveBeenCalledOnce();
  });

  it('auto-continues a session that is 30 min old without classify', async () => {
    getSession.mockResolvedValue({
      username: 'u',
      lastSessionId: 's-42-1',
      lastMessageAt: Date.now() - 30 * 60 * 1000,
    });

    await handleMessage({ chat: { id: CHAT_ID }, text: 'продолжим', message_id: 5, date: Math.floor(Date.now() / 1000) }, env);

    expect(classifyMessage).not.toHaveBeenCalled();
    expect(runTask).toHaveBeenCalledOnce();
    expect(runTask.mock.calls[0][1].sessionId).toBe('s-42-1');
  });
});

describe('ambiguous routing uses projects', () => {
  it.each(['low', 'medium', 'error', 'unknown-id', 'list-error', 'null'])('%s never opens a dialog menu', async outcome => {
    getProjectDecision.mockResolvedValue({ action: 'ask', choices: [{ id: 'p1' }, { id: 'p2' }] });
    getSessions.mockResolvedValue(TWO_SESSIONS.map(s => ({ ...s, lastAt: Date.now() - 60000 })));
    if (outcome === 'error') classifyMessage.mockRejectedValue(new Error('offline'));
    else if (outcome === 'list-error') getSessions.mockRejectedValue(new Error('offline'));
    else classifyMessage.mockResolvedValue(outcome === 'null' ? null : {
      confidence: outcome === 'unknown-id' ? 'high' : outcome,
      sessionId: outcome === 'unknown-id' ? 'foreign-id' : 's-42-1',
    });
    const input = { chat: { id: CHAT_ID }, text: 'проверь задачу', message_id: 90 };
    await handleMessage(input, env, { mode: 'deep' });
    expect(openProjectChoice).toHaveBeenCalledWith(env, CHAT_ID, expect.anything(), expect.objectContaining({
      input, opts: { mode: 'deep', initialMsgId: null },
    }));
    expect(sendMessageWithKeyboard).not.toHaveBeenCalled();
    expect(runTask).not.toHaveBeenCalled();
  });
  it('auto-runs a validated high-confidence match', async () => {
    classifyMessage.mockResolvedValue({ confidence: 'high', sessionId: 's-42-1' });
    await handleMessage({ chat: { id: CHAT_ID }, text: 'продолжи вакансию' }, env);
    expect(runTask.mock.calls[0][1]).toMatchObject({ sessionId: 's-42-1', forceNew: false });
    expect(openProjectChoice).not.toHaveBeenCalled();
  });
  it('resolves a sole project without inheriting the old project', async () => {
    getSession.mockResolvedValue({ username: 'u', lastSessionId: 'old', projectId: 'old-project' });
    getProjectDecision.mockResolvedValue({ action: 'auto', choices: [{ id: 'only-project' }] });
    await handleMessage({ chat: { id: CHAT_ID }, text: 'проверь' }, env);
    expect(runTask.mock.calls[0][1]).toMatchObject({ forceNew: true, projectId: 'only-project' });
    expect(setSession.mock.calls.at(-1)[2].projectId).toBe('only-project');
  });
  it('does not classify across project boundaries', async () => {
    getSession.mockResolvedValue({ username: 'u', lastSessionId: 'old', projectId: 'p1' });
    getSessions.mockResolvedValue([{ id: 'foreign', projectId: 'p2' }]);
    await handleMessage({ chat: { id: CHAT_ID }, text: 'проверь' }, env);
    expect(classifyMessage).not.toHaveBeenCalled();
    expect(runTask.mock.calls[0][1].forceNew).toBe(true);
  });
});
