import { cleanupReadiness } from './e2e-oracle.mjs';

const PROFILE_ID = 'production-e2e-telegram-v1';

export async function waitForProdPrincipalRestore(readEvidence, {
  cleanupStrandedDraft,
  timeoutMs = 120_000,
  intervalMs = 2_000,
  now = () => Date.now(),
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
} = {}) {
  const deadline = now() + timeoutMs;
  let profileObserved = false;
  let readiness = null;
  let strandedDraftCleaned = false;
  while (now() <= deadline) {
    let observed;
    try { observed = await readEvidence(); } catch { observed = null; }
    if (observed?.status === 200 && observed.evidence?.profileId === PROFILE_ID) {
      profileObserved = true;
      readiness = cleanupReadiness(observed.evidence);
      if (readiness.ready) return { safeToRestore: true,
        reasonCode: strandedDraftCleaned ? 'terminal_idle_after_scoped_draft_cleanup' : 'terminal_and_idle',
        strandedDraftCleaned, ...readiness };
      const buffer = observed.evidence.buffer ?? {};
      const safelyClearableDraft = readiness.tasksTerminal && Number.isSafeInteger(buffer.pendingCount)
        && buffer.pendingCount > 0 && buffer.busy !== true
        && (buffer.launching ?? 0) === 0 && (buffer.unresolvedLaunchCount ?? 0) === 0
        && (buffer.busyRequestCount ?? 0) === 0 && buffer.alarmAt == null;
      if (safelyClearableDraft && !strandedDraftCleaned && typeof cleanupStrandedDraft === 'function') {
        try { strandedDraftCleaned = await cleanupStrandedDraft() === true; } catch { strandedDraftCleaned = false; }
      }
    }
    if (now() >= deadline) break;
    await sleep(Math.min(intervalMs, deadline - now()));
  }
  if (!profileObserved) return { safeToRestore: false, reasonCode: 'prod_principal_lane_evidence_unavailable' };
  return { safeToRestore: false, reasonCode: 'prod_principal_task_or_buffer_not_terminal',
    strandedDraftCleaned, ...readiness };
}
