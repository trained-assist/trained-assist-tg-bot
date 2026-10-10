import assert from 'node:assert/strict';

export async function runSandboxEntryScenario(workerRequest, {
  target = 'sandbox', chatId = -1000000000236, userId = 900000236, delivery = 'capture',
} = {}) {
  // This pre-login scenario cannot start a model run. The caller chooses a
  // reserved fixture identity or the pinned real-delivery sandbox identity.
  const send = text => workerRequest('/operator/test-update', {
    target, type: 'message', delivery, chatId, userId, text,
  });
  const assertRealDelivery = response => {
    if (delivery !== 'telegram') return;
    const sent = response.transcript?.filter(item => item.kind === 'sendMessage') ?? [];
    if (!sent.some(item => item.telegramOk === true && Number.isSafeInteger(item.messageId) && item.messageId > 0)) {
      const reason = sent.find(item => typeof item.errorClass === 'string')?.errorClass ?? 'unknown';
      throw new Error(`telegram_send_not_confirmed:${reason}`);
    }
  };

  const help = await send('/help');
  assertRealDelivery(help);
  assert.equal(help.ok, true);
  assert.equal(help.delivery, delivery);
  assert(help.transcript?.some(item => item.text?.includes('Команды: /help, /status')),
    'help_command_reply_missing');

  const status = await send('/status');
  assertRealDelivery(status);
  assert.equal(status.ok, true);
  assert.equal(status.admission?.serviceCommand, 'status');
  assert.equal(status.admission?.active, false, 'new_user_status_reports_active_work');
  assert.equal(status.admission?.pending, 0, 'new_user_status_reports_pending_input');

  const question = await send('What can you help me with?');
  assertRealDelivery(question);
  assert.equal(question.ok, true);
  assert.equal(question.admission?.authenticated, false, 'anonymous_question_was_authenticated');
  assert(question.transcript?.some(item => item.text?.includes('/login username password')),
    'anonymous_question_did_not_prompt_login');
  assert.equal(question.collector?.pendingCount, 0, 'anonymous_question_was_added_to_intake');
  assert.equal(question.collector?.busy, false, 'anonymous_question_started_work');
  assert.equal(question.collector?.controlPlaneBarrier?.busyRequestCount ?? 0, 0);
  assert.equal(question.collector?.controlPlaneBarrier?.unresolvedLaunchCount ?? 0, 0);

  return { ok: true, scenario: 'new-user-entry-before-login',
    helpReply: true, statusIdle: true, loginPrompted: true, anonymousInputNotQueued: true };
}
