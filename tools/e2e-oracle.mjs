export function controlPlaneBarrierCounts(collector) {
  const barrier = collector?.controlPlaneBarrier ?? {};
  return {
    busyRequestCount: Number.isSafeInteger(barrier.busyRequestCount) ? barrier.busyRequestCount : 0,
    unresolvedLaunchCount: Number.isSafeInteger(barrier.unresolvedLaunchCount) ? barrier.unresolvedLaunchCount : 0,
  };
}

export function summarizeLaunch(launch) {
  const collector = launch?.collector ?? {};
  const barrier = controlPlaneBarrierCounts(collector);
  return {
    callbackAccepted: launch?.ok === true,
    pendingCount: Number.isSafeInteger(collector.pendingCount) ? collector.pendingCount : null,
    busy: collector.busy === true,
    launchingCount: Array.isArray(collector.launchingMessageIds) ? collector.launchingMessageIds.length : null,
    controlPlaneBarrierPresent: collector.controlPlaneBarrier !== null && collector.controlPlaneBarrier !== undefined,
    ...barrier,
  };
}

export function launchWasDispatched(launch, beforeCollector = {}) {
  const collector = launch?.collector ?? {};
  const beforeBarrier = controlPlaneBarrierCounts(beforeCollector);
  const afterBarrier = controlPlaneBarrierCounts(collector);
  return collector.pendingCount === 0 || collector.busy === true ||
    (Array.isArray(collector.launchingMessageIds) && collector.launchingMessageIds.length > 0) ||
    afterBarrier.busyRequestCount > beforeBarrier.busyRequestCount ||
    afterBarrier.unresolvedLaunchCount > beforeBarrier.unresolvedLaunchCount;
}

export function summarizeIntakeState(buffer = {}) {
  return {
    pendingCount: Number.isSafeInteger(buffer.pendingCount) ? buffer.pendingCount : null,
    busy: buffer.busy === true,
    launching: Number.isSafeInteger(buffer.launching) ? buffer.launching : 0,
    unresolvedLaunchCount: Number.isSafeInteger(buffer.unresolvedLaunchCount) ? buffer.unresolvedLaunchCount : 0,
    busyRequestCount: Number.isSafeInteger(buffer.busyRequestCount) ? buffer.busyRequestCount : 0,
    alarmPresent: Number.isSafeInteger(buffer.alarmAt),
    alarmAt: Number.isSafeInteger(buffer.alarmAt) ? buffer.alarmAt : null,
    stranded: buffer.stranded === true,
  };
}

export function intakeIsIdle(buffer) {
  const state = summarizeIntakeState(buffer);
  return state.pendingCount === 0 && !state.busy && state.launching === 0 &&
    state.unresolvedLaunchCount === 0 && state.busyRequestCount === 0;
}

export function cleanupReadiness(evidence = {}) {
  const tasksTerminal = (evidence.tasks ?? []).every(task => ['done', 'failed', 'cancelled'].includes(task.status));
  return { ready: tasksTerminal && intakeIsIdle(evidence.buffer), tasksTerminal,
    intakeIdle: intakeIsIdle(evidence.buffer) };
}

export function dispatched(newId, baselineIds = []) {
  if (typeof newId !== 'string' || newId.length === 0) return false;
  const baseline = baselineIds instanceof Set ? baselineIds : new Set(baselineIds);
  return !baseline.has(newId);
}
