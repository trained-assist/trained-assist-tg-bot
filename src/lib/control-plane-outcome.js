export function controlPlaneRunFailureCode(run) {
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
  if (controlPlaneRunHadNoVisibleOutcome(status)) {
    return '❌ Исполнитель завершил задачу без текстового ответа. Результат не подтверждён; проверьте задачу перед повторным запуском.';
  }
  return 'Ошибка исполнителя.';
}
