import { describe, expect, it } from 'vitest';
import { runSandboxEntryScenario } from '../tools/sandbox-entry-smoke-lib.mjs';

const response = (text, admission, collector = null, delivery = 'capture') => ({ ok: true, delivery,
  transcript: [{ text }], admission, collector });

describe('sandbox new-user entry scenario', () => {
  it('checks immediate help/status and refuses to queue an anonymous question', async () => {
    const calls = [];
    const replies = [
      response('Команды: /help, /status', { serviceCommand: 'help' }),
      response('Активных задач и несобранного ввода нет.', { serviceCommand: 'status', active: false, pending: 0 }),
      response('Чтобы войти: /login username password', { authenticated: false }, {
        pendingCount: 0, busy: false, controlPlaneBarrier: { busyRequestCount: 0, unresolvedLaunchCount: 0 },
      }),
    ];
    const report = await runSandboxEntryScenario(async (path, body) => {
      calls.push({ path, body });
      return replies.shift();
    });

    expect(report).toEqual({ ok: true, scenario: 'new-user-entry-before-login',
      helpReply: true, statusIdle: true, loginPrompted: true, anonymousInputNotQueued: true });
    expect(calls).toHaveLength(3);
    expect(calls.every(call => call.path === '/operator/test-update' && call.body.delivery === 'capture')).toBe(true);
  });

  it('fails when the anonymous question is queued in Intake', async () => {
    const replies = [
      response('Команды: /help, /status', { serviceCommand: 'help' }),
      response('idle', { serviceCommand: 'status', active: false, pending: 0 }),
      response('Для входа: /login username password', { authenticated: false }, { pendingCount: 1, busy: false }),
    ];
    await expect(runSandboxEntryScenario(async () => replies.shift()))
      .rejects.toThrow('anonymous_question_was_added_to_intake');
  });

  it('uses the pinned sandbox3 identity and real Telegram delivery when requested', async () => {
    const calls = [];
    const replies = [
      response('Команды: /help, /status', { serviceCommand: 'help' }, null, 'telegram'),
      response('idle', { serviceCommand: 'status', active: false, pending: 0 }, null, 'telegram'),
      response('Для входа: /login username password', { authenticated: false },
        { pendingCount: 0, busy: false }, 'telegram'),
    ];
    await runSandboxEntryScenario(async (path, body) => { calls.push(body); return replies.shift(); },
      { target: 'sandbox3', chatId: -1001234567890, userId: 1714048, delivery: 'telegram' });
    expect(calls).toHaveLength(3);
    expect(calls.every(body => body.target === 'sandbox3' && body.chatId === -1001234567890
      && body.userId === 1714048 && body.delivery === 'telegram')).toBe(true);
  });
});
