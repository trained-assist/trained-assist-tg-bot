const safeCode = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : null;

function summarizeGroup(group) {
  const tasks = Array.isArray(group?.tasks) ? group.tasks : [];
  return {
    unresolved: group?.unresolved === true,
    stopConfirmed: group?.stopConfirmed === true,
    reason: safeCode(group?.reason),
    taskCount: tasks.length,
    tasks: tasks.map(task => ({
      status: safeCode(task?.status),
      attemptCount: Array.isArray(task?.attempts) ? task.attempts.length : 0,
      attemptStates: Array.isArray(task?.attempts)
        ? task.attempts.map(attempt => safeCode(attempt?.status)).filter(Boolean)
        : [],
    })),
  };
}

export function summarizeStopDiagnostics({ replyConfirmed, inspectStatus, inspectPayload } = {}) {
  const entries = inspectPayload?.snapshot?.entries;
  const window = entries && typeof entries === 'object' ? entries.cpStopWindow : null;
  const groups = Array.isArray(window?.groups) ? window.groups : [];
  return {
    replyConfirmed: replyConfirmed === true,
    inspect: {
      available: inspectStatus === 200,
      status: Number.isSafeInteger(inspectStatus) ? inspectStatus : null,
      error: safeCode(inspectPayload?.error),
      reason: safeCode(inspectPayload?.reason),
    },
    stopWindow: window ? {
      pending: window.pending === true,
      unresolved: window.unresolved === true,
      stopConfirmed: window.stopConfirmed === true,
      reason: safeCode(window.reason),
      groupCount: groups.length,
      groups: groups.map(summarizeGroup),
    } : null,
  };
}
