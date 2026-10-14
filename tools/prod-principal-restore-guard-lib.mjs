import { cleanupReadiness } from './e2e-oracle.mjs';

const PROFILE_ID = 'production-e2e-telegram-v1';

export async function waitForProdPrincipalRestore(readEvidence, {
  timeoutMs = 120_000,
  intervalMs = 2_000,
  now = () => Date.now(),
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
} = {}) {
  const deadline = now() + timeoutMs;
  let profileObserved = false;
  let readiness = null;
  while (now() <= deadline) {
    let observed;
    try { observed = await readEvidence(); } catch { observed = null; }
    if (observed?.status === 200 && observed.evidence?.profileId === PROFILE_ID) {
      profileObserved = true;
      readiness = cleanupReadiness(observed.evidence);
      if (readiness.ready) return { safeToRestore: true, reasonCode: 'terminal_and_idle', ...readiness };
    }
    if (now() >= deadline) break;
    await sleep(Math.min(intervalMs, deadline - now()));
  }
  if (!profileObserved) return { safeToRestore: false, reasonCode: 'prod_principal_lane_evidence_unavailable' };
  return { safeToRestore: false, reasonCode: 'prod_principal_task_or_buffer_not_terminal', ...readiness };
}
