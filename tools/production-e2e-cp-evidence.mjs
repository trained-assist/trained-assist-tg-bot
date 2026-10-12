function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function safeCode(value) {
  return typeof value === 'string' && /^[a-z0-9_.:-]{1,100}$/i.test(value) ? value : null;
}

// Keep the production artifact useful for route diagnosis without ever copying
// task goals, result answers, or arbitrary event payloads into CI artifacts.
export function summarizeCpRouting(taskStore) {
  const row = parseObject(taskStore);
  const events = Array.isArray(row.history) ? row.history : [];
  const routingEvent = [...events].reverse().find(event => event?.kind === 'routing.selected');
  const selection = parseObject(routingEvent?.payload);
  const decision = parseObject(selection.decision);
  const result = parseObject(row.result);
  const quickAnswer = parseObject(result.quickAnswer);
  return {
    routingSelectionPersisted: !!routingEvent,
    decisionIdPresent: typeof selection.decisionId === 'string' && !!selection.decisionId,
    route: safeCode(decision.route),
    mode: safeCode(decision.mode),
    outcome: safeCode(decision.outcome),
    reasonCode: safeCode(decision.reasonCode),
    needsExecutor: typeof decision.needsExecutor === 'boolean' ? decision.needsExecutor : null,
    continuationPresent: selection.continuation != null,
    workOrderPresent: selection.workOrder != null,
    replyPresent: selection.reply != null,
    resultOk: typeof result.ok === 'boolean' ? result.ok : null,
    resultMode: safeCode(result.mode),
    resultStatus: safeCode(result.status),
    resultReasonCode: safeCode(result.reasonCode),
    quickAnswerCapabilityId: safeCode(quickAnswer.id),
    quickAnswerCapabilityVersion: Number.isSafeInteger(quickAnswer.version) ? quickAnswer.version : null,
  };
}
