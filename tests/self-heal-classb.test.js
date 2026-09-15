import { describe, it, expect, vi, beforeEach } from 'vitest';

// Class B self-heal (issue #604): when classifyAgentError reports 'down', the
// gateway used to dead-end with "попробуй через минуту" — the human had to notice
// and manually resend. Now it queues ONE delayed retry (drained by the Cron
// Trigger's scheduled() → processDueRetries) and only surfaces a real error if
// the agent is still down after that retry (cap-at-1, per the issue's design
// constraints).

const runTask = vi.fn();
const getProjectDecision = vi.fn();
const getSessions = vi.fn();
const classifyMessage = vi.fn();
const classifyAgentError = vi.fn();
const sendMessage = vi.fn();
const setSession = vi.fn();
const getSession = vi.fn();
const scheduleRetry = vi.fn();
const takeDueRetries = vi.fn();

vi.mock('../src/lib/agent-client.js', () => ({
  runTask: (...a) => runTask(...a),
  getSessions: (...a) => getSessions(...a),
  classifyMessage: (...a) => classifyMessage(...a),
  getProjectDecision: (...a) => getProjectDecision(...a),
  classifyAgentError: (...a) => classifyAgentError(...a),
}));
vi.mock('../src/lib/kv.js', () => ({
  getSession: (...a) => getSession(...a),
  setSession: (...a) => setSession(...a),
  newSessionId: (chatId) => `s-${chatId}-new`,
  scheduleRetry: (...a) => scheduleRetry(...a),
  takeDueRetries: (...a) => takeDueRetries(...a),
}));
vi.mock('../src/lib/telegram.js', () => ({
  sendMessage: (...a) => sendMessage(...a),
  sendDocument: vi.fn(),
  sendMessageWithKeyboard: vi.fn(),
}));
vi.mock('../src/handlers/commands.js', () => ({ renderSessionList: () => ({ text: '', buttons: [] }) }));

import { handleMessage, processDueRetries } from '../src/handlers/message.js';

const env = { BOT_TOKEN: 't', SESSIONS: {} };

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({ username: 'u', lastSessionId: 's-1', lastMessageAt: Date.now() });
  getProjectDecision.mockResolvedValue({ action: 'auto' });
  sendMessage.mockResolvedValue({ ok: true, result: { message_id: 10 } });
  setSession.mockResolvedValue();
});

describe('first "down" on a live message → queue one delayed retry', () => {
  it('schedules a retry with the original chatId/text and tells the user, WITHOUT the old dead-end wording', async () => {
    runTask.mockRejectedValue(new Error('agent /run HTTP 502'));
    classifyAgentError.mockResolvedValue('down');

    await handleMessage({ chat: { id: 42 }, text: 'сделай штуку' }, env);

    expect(scheduleRetry).toHaveBeenCalledTimes(1);
    expect(scheduleRetry.mock.calls[0][1]).toMatchObject({ chatId: 42, text: 'сделай штуку' });
    const sentText = sendMessage.mock.calls.at(-1)[2];
    expect(sentText).toContain('3 минуты');
    expect(sentText).not.toContain('через минуту');
  });

  it('a file-attached task on "down" does NOT get queued (KV size-limit guard) but still tells the user', async () => {
    runTask.mockRejectedValue(new Error('agent /run HTTP 502'));
    classifyAgentError.mockResolvedValue('down');

    // Direct photo path builds opts.fileBase64 internally — exercise via handleMessage.
    globalThis.fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]).buffer));
    await handleMessage({ chat: { id: 42 }, photo: [{ file_id: 'p1' }] }, env);

    expect(scheduleRetry).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalled();
  });

  it('"busy" and plain "error" classifications are unaffected (no queueing, existing wording)', async () => {
    runTask.mockRejectedValue(new Error('boom'));
    classifyAgentError.mockResolvedValue('busy');
    await handleMessage({ chat: { id: 42 }, text: 'x' }, env);
    expect(scheduleRetry).not.toHaveBeenCalled();
    expect(sendMessage.mock.calls.at(-1)[2]).toContain('занят');

    vi.clearAllMocks();
    getSession.mockResolvedValue({ username: 'u', lastSessionId: 's-1', lastMessageAt: Date.now() });
    runTask.mockRejectedValue(new Error('boom'));
    classifyAgentError.mockResolvedValue('error');
    await handleMessage({ chat: { id: 42 }, text: 'x' }, env);
    expect(scheduleRetry).not.toHaveBeenCalled();
    expect(sendMessage.mock.calls.at(-1)[2]).toContain('Ошибка');
  });
});

describe('the scheduled retry itself (opts.isRetry) — cap at exactly one attempt', () => {
  it('processDueRetries re-runs the task; success needs no further user message about downtime', async () => {
    takeDueRetries.mockResolvedValue([{ chatId: 42, text: 'сделай штуку', opts: { mode: null } }]);
    runTask.mockResolvedValue({ pinnedMsgId: null });

    await processDueRetries(env);

    expect(runTask).toHaveBeenCalledTimes(1);
    expect(scheduleRetry).not.toHaveBeenCalled();
  });

  it('still down on the retry → final error message, NOT another scheduled retry', async () => {
    takeDueRetries.mockResolvedValue([{ chatId: 42, text: 'сделай штуку', opts: {} }]);
    runTask.mockRejectedValue(new Error('agent /run HTTP 503'));
    classifyAgentError.mockResolvedValue('down');

    await processDueRetries(env);

    expect(scheduleRetry).not.toHaveBeenCalled();
    const sentText = sendMessage.mock.calls.at(-1)[2];
    expect(sentText).toContain('после повторной попытки');
  });

  it('skips silently if the user logged out before the retry fired', async () => {
    takeDueRetries.mockResolvedValue([{ chatId: 42, text: 'сделай штуку', opts: {} }]);
    getSession.mockResolvedValue(null);

    await processDueRetries(env);

    expect(runTask).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
