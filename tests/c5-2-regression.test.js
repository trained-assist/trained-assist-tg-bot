import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cleanupReadiness, intakeIsIdle, launchWasDispatched, summarizeIntakeState } from '../tools/e2e-oracle.mjs';
import { isResetLock409 } from '../tools/sandbox-buffer-cycle.mjs';

const readSource = name => readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8');

describe('C5.2 #650 reset-lock 409 retry', () => {
  it('detects reset_in_progress and reset_already_in_progress on reset-sandbox-state path', () => {
    expect(isResetLock409('/operator/reset-sandbox-state', { error: 'reset_in_progress' })).toBe(true);
    expect(isResetLock409('/operator/reset-sandbox-state', { error: 'reset_already_in_progress' })).toBe(true);
  });

  it('does not detect other errors or paths', () => {
    expect(isResetLock409('/operator/reset-sandbox-state', { error: 'other' })).toBe(false);
    expect(isResetLock409('/operator/test-update', { error: 'reset_in_progress' })).toBe(false);
  });
});

describe('C5.2 #640 dispatch evidence', () => {
  it('does not misattribute a pre-existing CP barrier to a new launch', () => {
    const barrier = { busyRequestCount: 0, unresolvedLaunchCount: 1 };
    const after = { collector: { pendingCount: 1, busy: false, launchingMessageIds: [],
      controlPlaneBarrier: barrier } };
    expect(launchWasDispatched(after, { controlPlaneBarrier: barrier })).toBe(false);
  });

  it('recognizes newly created CP barrier counts as dispatch evidence', () => {
    const after = { collector: { pendingCount: 1, busy: false, launchingMessageIds: [],
      controlPlaneBarrier: { busyRequestCount: 1, unresolvedLaunchCount: 0 } } };
    expect(launchWasDispatched(after, { controlPlaneBarrier: { busyRequestCount: 0, unresolvedLaunchCount: 0 } })).toBe(true);
  });
});

describe('C5.2 #647 collector retry after explicit Telegram rejection', () => {
  it('records an explicit ok:false send as rejected so the next alarm retries it', () => {
    const source = readSource('src/intake-buffer.js');
    expect(source).toMatch(/sent\?\.ok === false/);
    expect(source).toMatch(/state: 'rejected'/);
  });
});

describe('C5.2 #641 intake idle before follow-up', () => {
  it('reports idle only when pending, busy, launching, and CP barriers are all zero', () => {
    expect(intakeIsIdle({ pendingCount: 0, busy: false, launching: 0,
      unresolvedLaunchCount: 0, busyRequestCount: 0 })).toBe(true);
    expect(intakeIsIdle({ pendingCount: 0, busy: true, launching: 0,
      unresolvedLaunchCount: 0, busyRequestCount: 0 })).toBe(false);
    expect(intakeIsIdle({ pendingCount: 1, busy: false, launching: 0,
      unresolvedLaunchCount: 0, busyRequestCount: 0 })).toBe(false);
    expect(summarizeIntakeState({ pendingCount: 1, busy: false, stranded: true })).toMatchObject({
      pendingCount: 1, busy: false, stranded: true, alarmPresent: false,
    });
  });
});
