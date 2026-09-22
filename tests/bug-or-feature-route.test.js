import { describe, it, expect, vi, beforeEach } from 'vitest';

// Guards PR3 (Harness A) of the Bugs & Features intake redesign — see
// generic-gtd-task-management-automation/BUGS-AND-FEATURES-SPEC.md §5.2/§3.4.
// /bug_or_feature (+ aliases) must ALWAYS force a brand-new session, never continue
// whatever the chat's last regular session was — otherwise the agent's
// BUG_OR_FEATURE_INTENT handler creates an orphan bugs-project session that the
// gateway's lastSessionId never points at, and every buffered follow-up after ▶️
// launches into the unrelated old session instead.

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
  shouldAskProject: () => false,
  FORCE_RUN_RE: /^never$/,
  hasIntakeContent: () => true,
  coalesceItem: (i) => i?.text || '',
  coalesceBuffer: (buf) => buf.map(i => i?.text || '').join('\n'),
}));
vi.mock('../src/lib/project-choice.js', () => ({
  openProjectChoice: vi.fn(),
  projectChoiceExpired: vi.fn(() => false),
}));

import { handleMessage } from '../src/handlers/message.js';

const CHAT_ID = 42;
const RECENT = Date.now() - 5 * 60 * 1000; // 5 min ago — well within the "continue" window

const env = { BOT_TOKEN: 't', SESSIONS: {} };

beforeEach(() => {
  vi.clearAllMocks();
  sendMessage.mockResolvedValue({ ok: true, result: { message_id: 10 } });
  sendMessageWithKeyboard.mockResolvedValue({ ok: true, result: { message_id: 11 } });
  setSession.mockResolvedValue();
  runTask.mockResolvedValue({ ok: true });
  getProjectDecision.mockResolvedValue({ action: 'auto' });
  classifyMessage.mockResolvedValue({ sessionId: null, confidence: 'low' });
  getSessions.mockResolvedValue([]);
  getSession.mockResolvedValue({
    username: 'u',
    lastSessionId: 's-42-old-unrelated',
    lastMessageAt: RECENT, // recent enough that a plain command would normally continue it
  });
});

describe('resolveSessionRoute — /bug_or_feature always forces a fresh session', () => {
  it('does not continue the recent last session for /bug_or_feature', async () => {
    await handleMessage({ chat: { id: CHAT_ID }, text: '/bug_or_feature', message_id: 1, date: Math.floor(Date.now() / 1000) }, env);

    expect(runTask).toHaveBeenCalledTimes(1);
    const call = runTask.mock.calls[0][1]; // (env, payload)
    expect(call.sessionId).not.toBe('s-42-old-unrelated');
    expect(call.forceNew).toBe(true);
  });

  it('forces new session for the short alias /bug too', async () => {
    await handleMessage({ chat: { id: CHAT_ID }, text: '/bug детали бага', message_id: 2, date: Math.floor(Date.now() / 1000) }, env);

    const call = runTask.mock.calls[0][1];
    expect(call.sessionId).not.toBe('s-42-old-unrelated');
    expect(call.forceNew).toBe(true);
  });

  it('forces new session for the Cyrillic alias /баг', async () => {
    await handleMessage({ chat: { id: CHAT_ID }, text: '/баг', message_id: 3, date: Math.floor(Date.now() / 1000) }, env);

    const call = runTask.mock.calls[0][1];
    expect(call.sessionId).not.toBe('s-42-old-unrelated');
    expect(call.forceNew).toBe(true);
  });

  it('still continues the last session for an unrelated slash command', async () => {
    await handleMessage({ chat: { id: CHAT_ID }, text: '/hh_ats', message_id: 4, date: Math.floor(Date.now() / 1000) }, env);

    const call = runTask.mock.calls[0][1];
    expect(call.sessionId).toBe('s-42-old-unrelated');
    expect(call.forceNew).toBeFalsy();
  });
});
