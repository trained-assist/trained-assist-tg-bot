import assert from 'node:assert/strict';

export async function runSandboxEntryScenario(workerRequest) {
  // This isolated non-execution scenario uses the reserved fixture destination.
  // All updates are captured; a test regression must never route a model run here.
  const chatId = -1000000000236;
  const userId = 900000236;
  const send = text => workerRequest('/operator/test-update', {
    target: 'sandbox', type: 'message', delivery: 'capture', chatId, userId, text,
  });

  const help = await send('/help');
  assert.equal(help.ok, true);
  assert.equal(help.delivery, 'capture');
  assert(help.transcript?.some(item => item.text?.includes('Команды: /help, /status')),
    'help_command_reply_missing');

  const status = await send('/status');
  assert.equal(status.ok, true);
  assert.equal(status.admission?.serviceCommand, 'status');
  assert.equal(status.admission?.active, false, 'new_user_status_reports_active_work');
  assert.equal(status.admission?.pending, 0, 'new_user_status_reports_pending_input');

  const question = await send('What can you help me with?');
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
