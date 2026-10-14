import { describe, expect, it } from 'vitest';
import { waitForProdPrincipalRestore } from '../tools/prod-principal-restore-guard-lib.mjs';

describe('prod-principal safe restore guard', () => {
  it('waits through stale sandbox edge evidence until the isolated lane is observed idle', async () => {
    let now = 0;
    let reads = 0;
    const result = await waitForProdPrincipalRestore(async () => {
      reads += 1;
      if (reads === 1) return { status: 200, evidence: { profileId: 'integration-sandbox3-v1' } };
      return { status: 200, evidence: { profileId: 'production-e2e-telegram-v1', tasks: [],
        buffer: { pendingCount: 0, busy: false, launching: 0, unresolvedLaunchCount: 0, busyRequestCount: 0 } } };
    }, { timeoutMs: 5_000, intervalMs: 2_000, now: () => now,
      sleep: async milliseconds => { now += milliseconds; } });

    expect(reads).toBe(2);
    expect(result).toMatchObject({ safeToRestore: true, reasonCode: 'terminal_and_idle', tasksTerminal: true, intakeIdle: true });
  });

  it('refuses restore when the production lane is active or never becomes identifiable', async () => {
    let now = 0;
    const active = await waitForProdPrincipalRestore(async () => ({ status: 200,
      evidence: { profileId: 'production-e2e-telegram-v1', tasks: [{ status: 'active' }],
        buffer: { pendingCount: 1, busy: true } } }), {
      timeoutMs: 2_000, intervalMs: 1_000, now: () => now,
      sleep: async milliseconds => { now += milliseconds; },
    });
    expect(active).toMatchObject({ safeToRestore: false, reasonCode: 'prod_principal_task_or_buffer_not_terminal' });

    now = 0;
    const missing = await waitForProdPrincipalRestore(async () => ({ status: 409,
      evidence: { profileId: 'integration-sandbox3-v1' } }), {
      timeoutMs: 2_000, intervalMs: 1_000, now: () => now,
      sleep: async milliseconds => { now += milliseconds; },
    });
    expect(missing).toMatchObject({ safeToRestore: false, reasonCode: 'prod_principal_lane_evidence_unavailable' });
  });
});
