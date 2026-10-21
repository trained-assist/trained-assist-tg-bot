export function controlPlaneRunFailureCode(run) {
  // The worker crash is its own failure class: the runner reports it as
  // `WORKER_CRASH` (the VM worker process restarted mid-run), not as a
  // rejection of the request. It must stay distinguishable from
  // `runner_rejected`, otherwise the crash explanation is lost.
  if (run?.error_class === 'WORKER_CRASH') return 'WORKER_CRASH';
  if (run?.error_class !== 'runner_rejected') return null;
  if (run.failure_code === 'ENGINE_NOT_ALLOWED') return 'ENGINE_NOT_ALLOWED';
  return typeof run.error_text === 'string' && /(?:^|\s)ENGINE_NOT_ALLOWED(?:\b|:)/.test(run.error_text)
    ? 'ENGINE_NOT_ALLOWED' : null;
}

const EMPTY_OUTCOME_RE = /no_user_visible_outcome|without[_ ]outcome|empty[_ ](?:answer|result|completion)/i;

export function controlPlaneRunHadNoVisibleOutcome(status) {
  const result = status?.result;
  if (typeof result === 'string') return result.trim() === '';
  if (result && typeof result === 'object') {
    if (result.reason === 'no_user_visible_outcome' || result.exitReason === 'no_user_visible_outcome') return true;
    const answer = typeof result.answer === 'string' ? result.answer.trim() : '';
    if (answer === '' && (result.reason || result.exitReason)) {
      // A failed run that committed no answer is an empty outcome, not a
      // transport/infra failure.
      return /no_user_visible|empty|outcome/i.test(String(result.reason || result.exitReason));
    }
  }
  const runs = Array.isArray(status?.runs) ? status.runs : [];
  return runs.some(run => (typeof run?.error_text === 'string' && EMPTY_OUTCOME_RE.test(run.error_text))
    || (typeof run?.failure_code === 'string' && EMPTY_OUTCOME_RE.test(run.failure_code)));
}

export function controlPlaneFailureText(status) {
  const generation = status?.generation;
  const runs = Array.isArray(status?.runs) ? status.runs : [];
  if (Number.isSafeInteger(generation) && generation > 0 && runs.some(run => run?.generation === generation
    && run.status === 'failed' && controlPlaneRunFailureCode(run) === 'ENGINE_NOT_ALLOWED')) {
    return 'Ошибка настройки исполнителя: выбранный движок недоступен. Ввод сохранён.';
  }
  // A crashed worker is an infrastructure event, not a bad request: the user
  // needs to know the task was retried once and that their input is intact.
  // Only the failed attempt of the current generation speaks for this task —
  // an earlier generation's crash must not be attributed to it.
  if (Number.isSafeInteger(generation) && generation > 0 && runs.some(run => run?.generation === generation
    && run.status === 'failed' && controlPlaneRunFailureCode(run) === 'WORKER_CRASH')) {
    return '❌ Исполнитель аварийно завершился во время работы — это сбой среды исполнения, а не ошибка вашего запроса. '
      + 'Система автоматически перезапускает задачу один раз; если сбой повторился, отправьте запрос заново. Ввод сохранён.';
  }
  if (controlPlaneRunHadNoVisibleOutcome(status)) {
    return '❌ Исполнитель завершил задачу без текстового ответа. Результат не подтверждён; проверьте задачу перед повторным запуском.';
  }
  return 'Ошибка исполнителя.';
}
