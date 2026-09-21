import { describe, it, expect, vi, beforeEach } from 'vitest';

// Guards the session-disambiguation logic inside resolveSessionRoute:
//   1. Slash commands never show the picker (R-slash-nopicker).
//   2. Plain text with old session + multiple sessions → shows picker (baseline).
// Covers the bug: /hh_ats sent when last session is >2h old showed the
// "В какой диалог?" picker instead of executing the command directly.

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
const TWO_HOURS_AGO = Date.now() - 3 * 60 * 60 * 1000; // 3h ago → old session

// Two sessions → classifier would normally be invoked.
const TWO_SESSIONS = [
  { id: 's-42-1', topic: 'холодный поиск', lastAt: TWO_HOURS_AGO },
  { id: 's-42-2', topic: 'установка вакансии', lastAt: TWO_HOURS_AGO - 1000 },
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

describe('resolveSessionRoute — baseline: plain text shows picker when ambiguous', () => {
  it('shows session picker for plain text with old session and multiple sessions', async () => {
    classifyMessage.mockResolvedValue({ sessionId: null, confidence: 'low' });

    await handleMessage({ chat: { id: CHAT_ID }, text: 'что там с задачей', message_id: 3, date: Math.floor(Date.now() / 1000) }, env);

    // Picker was shown (text is mocked to 'pick' by the renderSessionList stub above)
    expect(sendMessageWithKeyboard).toHaveBeenCalledOnce();
    expect(runTask).not.toHaveBeenCalled();
  });
});
