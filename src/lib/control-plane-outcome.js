export function controlPlaneRunFailureCode(run) {
  if (run?.error_class !== 'runner_rejected') return null;
  if (run.failure_code === 'ENGINE_NOT_ALLOWED') return 'ENGINE_NOT_ALLOWED';
  return typeof run.error_text === 'string' && /(?:^|\s)ENGINE_NOT_ALLOWED(?:\b|:)/.test(run.error_text)
    ? 'ENGINE_NOT_ALLOWED' : null;
}

export function controlPlaneFailureText(status) {
  const generation = status?.generation;
  const runs = Array.isArray(status?.runs) ? status.runs : [];
  if (Number.isSafeInteger(generation) && generation > 0 && runs.some(run => run?.generation === generation
    && run.status === 'failed' && controlPlaneRunFailureCode(run) === 'ENGINE_NOT_ALLOWED')) {
    return 'Ошибка настройки исполнителя: выбранный движок недоступен. Ввод сохранён.';
  }
  return 'Ошибка исполнителя.';
}
