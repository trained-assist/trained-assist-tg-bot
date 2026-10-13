import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cleanupReadiness, controlPlaneBarrierCounts, dispatched, intakeIsIdle,
  launchWasDispatched, summarizeIntakeState, summarizeLaunch } from '../tools/e2e-oracle.mjs';

describe('e2e oracle barrier counts', () => {
  it('coerces safe integers and defaults a missing barrier to zero', () => {
    expect(controlPlaneBarrierCounts({})).toEqual({ busyRequestCount: 0, unresolvedLaunchCount: 0 });
    expect(controlPlaneBarrierCounts({ controlPlaneBarrier: {} }))
      .toEqual({ busyRequestCount: 0, unresolvedLaunchCount: 0 });
    expect(controlPlaneBarrierCounts({ controlPlaneBarrier: { busyRequestCount: 2,
      unresolvedLaunchCount: 3 } })).toEqual({ busyRequestCount: 2, unresolvedLaunchCount: 3 });
    expect(controlPlaneBarrierCounts({ controlPlaneBarrier: { busyRequestCount: 'x',
      unresolvedLaunchCount: null } })).toEqual({ busyRequestCount: 0, unresolvedLaunchCount: 0 });
  });
});

describe('e2e oracle launch summary', () => {
  it('does not treat the always-present empty CP barrier as dispatch evidence', () => {
    const result = { ok: true, collector: {
      pendingCount: 1, busy: false, launchingMessageIds: [],
      controlPlaneBarrier: { busyRequestCount: 0, unresolvedLaunchCount: 0 },
    } };

    expect(summarizeLaunch(result)).toMatchObject({ callbackAccepted: true,
      controlPlaneBarrierPresent: true, busyRequestCount: 0, unresolvedLaunchCount: 0 });
    expect(launchWasDispatched(result)).toBe(false);
  });

  it('recognizes buffer drain, active launch, and newly created CP barrier evidence', () => {
    const before = { controlPlaneBarrier: { busyRequestCount: 0, unresolvedLaunchCount: 0 } };
    expect(launchWasDispatched({ collector: { pendingCount: 0 } }, before)).toBe(true);
    expect(launchWasDispatched({ collector: { pendingCount: 1, busy: true } }, before)).toBe(true);
    expect(launchWasDispatched({ collector: { pendingCount: 1, launchingMessageIds: [7] } }, before))
      .toBe(true);
    expect(launchWasDispatched({ collector: { pendingCount: 1,
      controlPlaneBarrier: { busyRequestCount: 1, unresolvedLaunchCount: 0 } } }, before)).toBe(true);
  });

  it('does not misattribute an already-present CP barrier to the new launch', () => {
    const barrier = { busyRequestCount: 0, unresolvedLaunchCount: 1 };
    const before = { controlPlaneBarrier: barrier };
    const after = { collector: { pendingCount: 1, busy: false, launchingMessageIds: [],
      controlPlaneBarrier: barrier } };

    expect(launchWasDispatched(after, before)).toBe(false);
  });

  it('summarizes launch fields with safe fallbacks', () => {
    expect(summarizeLaunch({})).toMatchObject({ callbackAccepted: false, pendingCount: null,
      busy: false, launchingCount: null, controlPlaneBarrierPresent: false });
    expect(summarizeLaunch({ ok: true, collector: { pendingCount: 2, busy: true,
      launchingMessageIds: [1, 2] } })).toMatchObject({ callbackAccepted: true, pendingCount: 2,
      busy: true, launchingCount: 2 });
  });
});

describe('e2e oracle intake state', () => {
  it('waits for task completion to propagate to an idle Intake before sending a follow-up', () => {
    expect(intakeIsIdle({ pendingCount: 0, busy: false, launching: 0,
      unresolvedLaunchCount: 0, busyRequestCount: 0 })).toBe(true);
    expect(intakeIsIdle({ pendingCount: 0, busy: true, launching: 0,
      unresolvedLaunchCount: 0, busyRequestCount: 0 })).toBe(false);
    expect(intakeIsIdle({ pendingCount: 1, busy: false, launching: 0,
      unresolvedLaunchCount: 0, busyRequestCount: 0 })).toBe(false);
    expect(intakeIsIdle({ pendingCount: 0, busy: false, launching: 1,
      unresolvedLaunchCount: 0, busyRequestCount: 0 })).toBe(false);
    expect(intakeIsIdle({ pendingCount: 0, busy: false, launching: 0,
      unresolvedLaunchCount: 1, busyRequestCount: 0 })).toBe(false);
    expect(intakeIsIdle({ pendingCount: 0, busy: false, launching: 0,
      unresolvedLaunchCount: 0, busyRequestCount: 1 })).toBe(false);
    expect(summarizeIntakeState({ pendingCount: 1, busy: false, stranded: true })).toMatchObject({
      pendingCount: 1, busy: false, stranded: true, alarmPresent: false, alarmAt: null,
    });
    expect(summarizeIntakeState({ alarmAt: 1791878000000 })).toMatchObject({
      alarmPresent: true, alarmAt: 1791878000000,
    });
    expect(summarizeIntakeState({ alarmAt: 'soon' })).toMatchObject({
      alarmPresent: false, alarmAt: null,
    });
  });

  it('reports cleanup readiness only when tasks are terminal and intake is idle', () => {
    expect(cleanupReadiness({ tasks: [{ status: 'done' }], buffer: { pendingCount: 0,
      busy: false, launching: 0, unresolvedLaunchCount: 0, busyRequestCount: 0 } }))
      .toEqual({ ready: true, tasksTerminal: true, intakeIdle: true });
    expect(cleanupReadiness({ tasks: [{ status: 'active' }], buffer: { pendingCount: 0,
      busy: false, launching: 0, unresolvedLaunchCount: 0, busyRequestCount: 0 } }).ready).toBe(false);
    expect(cleanupReadiness({ tasks: [{ status: 'cancelled' }], buffer: { pendingCount: 1,
      busy: false, launching: 0, unresolvedLaunchCount: 0, busyRequestCount: 0 } }).ready).toBe(false);
    expect(cleanupReadiness({ tasks: [{ status: 'failed' }] })).toMatchObject({ tasksTerminal: true,
      intakeIdle: false, ready: false });
    expect(cleanupReadiness({ tasks: [], buffer: { pendingCount: 0, busy: false, launching: 0,
      unresolvedLaunchCount: 0, busyRequestCount: 0 } })).toMatchObject({ tasksTerminal: true,
      intakeIdle: true, ready: true });
  });
});

describe('e2e oracle identity dispatch check', () => {
  it('counts a task as dispatched only when its identity is new to the observed set', () => {
    expect(dispatched('task-1', ['task-0'])).toBe(true);
    expect(dispatched('task-1', ['task-0', 'task-1'])).toBe(false);
    expect(dispatched('task-1', new Set(['task-1']))).toBe(false);
    expect(dispatched('', ['task-0'])).toBe(false);
    expect(dispatched(null, ['task-0'])).toBe(false);
    expect(dispatched(undefined, [])).toBe(false);
    expect(dispatched('task-1')).toBe(true);
  });
});

describe('e2e oracle sandbox3 after-stop launch checks (C1.2)', () => {
  const launch = barrier => ({ ok: true, collector: { pendingCount: 1, busy: false,
    launchingMessageIds: [], controlPlaneBarrier: barrier } });

  it('replaces the during-stop busyRequestCount > 1 check with a baseline delta', () => {
    const duringStopBaseline = { controlPlaneBarrier: { busyRequestCount: 1, unresolvedLaunchCount: 0 } };

    expect(launchWasDispatched(
      launch({ busyRequestCount: 2, unresolvedLaunchCount: 0 }), duringStopBaseline)).toBe(true);
    expect(launchWasDispatched(
      launch({ busyRequestCount: 1, unresolvedLaunchCount: 1 }), duringStopBaseline)).toBe(true);
    expect(launchWasDispatched(
      launch({ busyRequestCount: 1, unresolvedLaunchCount: 0 }), duringStopBaseline)).toBe(false);
    expect(launchWasDispatched({ ok: true, collector: { pendingCount: 0, busy: false,
      launchingMessageIds: [], controlPlaneBarrier: { busyRequestCount: 1, unresolvedLaunchCount: 0 } } },
    duringStopBaseline)).toBe(true);
  });

  it('replaces the after-stop busyRequestCount > 0 check with an empty baseline', () => {
    const afterStopBaseline = {};

    expect(launchWasDispatched(
      launch({ busyRequestCount: 1, unresolvedLaunchCount: 0 }), afterStopBaseline)).toBe(true);
    expect(launchWasDispatched(
      launch({ busyRequestCount: 0, unresolvedLaunchCount: 1 }), afterStopBaseline)).toBe(true);
    expect(launchWasDispatched(
      launch({ busyRequestCount: 0, unresolvedLaunchCount: 0 }), afterStopBaseline)).toBe(false);
    expect(launchWasDispatched({ ok: true, collector: { pendingCount: 0, busy: false,
      launchingMessageIds: [], controlPlaneBarrier: { busyRequestCount: 0, unresolvedLaunchCount: 0 } } },
    afterStopBaseline)).toBe(true);
  });

  it('does not attribute a pre-existing during-stop barrier entry to the new launch', () => {
    const before = { controlPlaneBarrier: { busyRequestCount: 1, unresolvedLaunchCount: 1 } };
    const after = { ok: true, collector: { pendingCount: 1, busy: false, launchingMessageIds: [],
      controlPlaneBarrier: { busyRequestCount: 1, unresolvedLaunchCount: 1 } } };

    expect(launchWasDispatched(after, before)).toBe(false);
  });
});

describe('e2e oracle adoption guard (C1.2)', () => {
  const readTool = name => readFileSync(fileURLToPath(new URL(`../tools/${name}`, import.meta.url)), 'utf8');

  it('keeps sandbox3 after-stop dispatch checks on the shared oracle', () => {
    const source = readTool('sandbox3-agent-e2e.mjs');
    expect(source).toMatch(/launchWasDispatched\(freshLaunch, freshQuestion\.collector\)/);
    expect(source).not.toMatch(/busyRequestCount \?\? 0\) > \d/);
  });

  it('keeps production lane buffer summaries on the shared oracle', () => {
    expect(readTool('prod-principal-state-probe.mjs')).toMatch(/summarizeIntakeState\(evidence\.buffer\)/);
    expect(readTool('prod-principal-restore-guard.mjs')).toMatch(/intakeIsIdle\(evidence\.buffer\)/);
    expect(readTool('prod-principal-resume-held-input.mjs')).toMatch(/intakeIsIdle\(evidence\.buffer\)/);
    expect(readTool('sandbox-entry-smoke-lib.mjs')).toMatch(/controlPlaneBarrierCounts\(question\.collector\)/);
  });
});
