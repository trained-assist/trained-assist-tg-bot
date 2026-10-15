const elapsedLabel = milliseconds => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds} сек`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} мин ${seconds % 60} сек`;
  return `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`;
};

/** User-safe projection of durable task/run state; it never infers liveness from an HTTP request. */
export function liveRunProgress({ taskStatus, runStatus, startedAt, finishedAt, now = Date.now() }) {
  const endAt = Number.isFinite(finishedAt) && finishedAt > 0 ? finishedAt : now;
  const age = Number.isFinite(startedAt) && startedAt > 0 ? Math.max(0, endAt - startedAt) : null;
  const timer = age === null ? '' : ` · ⏱ ${elapsedLabel(age)}`;
  if (['done', 'completed', 'succeeded'].includes(taskStatus)) return `✅ Выполнено${timer}`;
  if (['failed', 'error'].includes(taskStatus)) return `❌ Завершилось с ошибкой${timer}`;
  if (['cancelled', 'canceled', 'stopped'].includes(taskStatus)) return `⏹ Остановлено${timer}`;
  if (taskStatus === 'awaiting_input' || runStatus === 'awaiting_input') return `❔ Жду вашего ответа${timer}`;
  if (['retrying', 'retry_pending'].includes(runStatus)) return `🔄 Повторяю запуск${timer}`;
  if (runStatus === 'unknown') return '🔎 Проверяю состояние запуска';
  if (taskStatus === 'waiting' || runStatus === 'waiting') return `⏳ Ожидаю следующий шаг${timer}`;
  if (taskStatus === 'running' || runStatus === 'running') return `⚙️ OpenCode работает${timer}`;
  if (taskStatus === 'queued' || taskStatus === 'accepted' || taskStatus === 'admitted') return '📨 Задача принята, запуск ожидает';
  if (taskStatus === 'active') return '⏳ Подготавливаю или проверяю запуск';
  return null;
}

export function assistantMessageFromEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload) ? event.payload : {};
  const nested = payload.payload && typeof payload.payload === 'object' && !Array.isArray(payload.payload) ? payload.payload : {};
  const isAssistant = event.type === 'assistant_message' || payload.type === 'assistant_message';
  const text = typeof nested.text === 'string' ? nested.text : typeof payload.text === 'string' ? payload.text : null;
  if (!isAssistant || !text?.trim()) return null;
  const runId = typeof event.runId === 'string' ? event.runId : typeof payload.runId === 'string' ? payload.runId : null;
  const eventId = typeof event.eventId === 'string' ? event.eventId : typeof payload.eventId === 'string' ? payload.eventId : null;
  const sequence = Number.isSafeInteger(event.sequence) ? event.sequence : null;
  if (!runId || (!eventId && sequence === null)) return null;
  const sessionId = typeof nested.sessionId === 'string' ? nested.sessionId : typeof payload.sessionId === 'string' ? payload.sessionId : null;
  const messageId = typeof nested.messageId === 'string' ? nested.messageId : typeof payload.messageId === 'string' ? payload.messageId : null;
  if (!sessionId || !messageId) return null;
  return { runId, eventId: eventId ?? `seq-${sequence}`, sessionId, messageId, text: text.trim().slice(0, 4096) };
}
