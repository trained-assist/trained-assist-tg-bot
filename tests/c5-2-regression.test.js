import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cleanupReadiness, intakeIsIdle, launchWasDispatched, summarizeIntakeState } from '../tools/e2e-oracle.mjs';
import { isResetLock409 } from '../tools/sandbox-buffer-cycle.mjs';
import { liveLaneIsReady, waitForCleanupReadiness } from '../tools/prod-principal-telegram-canary.mjs';

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

describe('C5.2 #638 explicit production E2E agent task', () => {
  it('sends a concrete user task instead of an echo-only token prompt', () => {
    const source = readSource('tools/prod-principal-telegram-canary.mjs');
    expect(source).toMatch(/Create a concise three-step checklist for organizing a small community event/);
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

describe('C5.2 #631 wake precondition', () => {
  it('exposes safe paused ingress and delivery preconditions', () => {
    const source = readSource('src/sandbox-tg/existing-ux.js');
    expect(source).toMatch(/test_ingress_paused/);
    expect(source).toMatch(/test_delivery_paused/);
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

describe('C5.2 #642 read-only inspection paused', () => {
  it('keeps inspection workflow paused instead of redeploying the live lane', () => {
    const source = readSource('.github/workflows/prod-principal-telegram-canary.yml');
    expect(source).toMatch(/inputs\.inspect_e2e_lane == true/);
  });
});

describe('C5.2 #643 cleanup waits for dispatch settle', () => {
  it('waits for terminal CP task and idle Intake before cleanup', async () => {
    let now = 0;
    let reads = 0;
    const terminalButBusy = { tasks: [{ status: 'done' }], buffer: { pendingCount: 0,
      busy: true, launching: 0, unresolvedLaunchCount: 0, busyRequestCount: 1 } };
    const terminalAndIdle = { tasks: [{ status: 'done' }], buffer: { pendingCount: 0,
      busy: false, launching: 0, unresolvedLaunchCount: 0, busyRequestCount: 0 } };

    expect(cleanupReadiness(terminalButBusy)).toMatchObject({ ready: false, tasksTerminal: true, intakeIdle: false });
    const result = await waitForCleanupReadiness(async () => ++reads === 1 ? terminalButBusy : terminalAndIdle, {
      timeoutMs: 5_000, intervalMs: 2_000, now: () => now,
      sleep: async ms => { now += ms; },
    });
    expect(reads).toBe(2);
    expect(result).toMatchObject({ ready: true, tasksTerminal: true, intakeIdle: true, evidence: terminalAndIdle });
  });

  it('leaves cleanup deferred if dispatch does not become idle before deadline', async () => {
    let now = 0;
    const result = await waitForCleanupReadiness(async () => ({ tasks: [{ status: 'done' }],
      buffer: { pendingCount: 0, busy: true, launching: 0, unresolvedLaunchCount: 0, busyRequestCount: 1 } }), {
      timeoutMs: 3_000, intervalMs: 2_000, now: () => now,
      sleep: async ms => { now += ms; },
    });
    expect(result).toMatchObject({ ready: false, tasksTerminal: true, intakeIdle: false });
  });
});

describe('C5.2 #644 isolated Worker propagation', () => {
  it('waits for the intended profile identity and live readiness before sending', () => {
    expect(liveLaneIsReady({ profileId: 'production-e2e-telegram-v1', readiness: {
      testApiEnabled: true, ingressPaused: false, deliveryPaused: false,
    } })).toBe(true);
    expect(liveLaneIsReady({ profileId: 'integration-sandbox3-v1', readiness: {
      testApiEnabled: true, ingressPaused: false, deliveryPaused: false,
    } })).toBe(false);
    expect(liveLaneIsReady({ profileId: 'production-e2e-telegram-v1', readiness: {
      testApiEnabled: true, ingressPaused: true, deliveryPaused: true,
    } })).toBe(false);
  });
});
