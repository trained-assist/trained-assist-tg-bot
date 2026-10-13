import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cleanupReadiness, durableTurnVerdict, intakeIsIdle, launchWasDispatched, liveLaneIsReady,
  summarizeIntakeState, summarizeLaunch, verifyLaneIdentity, waitForCleanupReadiness } from '../tools/prod-principal-telegram-canary.mjs';

describe('production Telegram canary launch evidence', () => {
  it('waits for the isolated profile identity and live readiness before sending a user update', () => {
    expect(liveLaneIsReady({ profileId: 'integration-sandbox3-v1', readiness: {
      testApiEnabled: true, ingressPaused: false, deliveryPaused: false,
    } })).toBe(false);
    expect(liveLaneIsReady({ profileId: 'production-e2e-telegram-v1', readiness: {
      testApiEnabled: true, ingressPaused: true, deliveryPaused: true,
    } })).toBe(false);
    expect(liveLaneIsReady({ profileId: 'production-e2e-telegram-v1', readiness: {
      testApiEnabled: true, ingressPaused: false, deliveryPaused: false,
    } })).toBe(true);
  });

  it('does not treat the always-present empty CP barrier as dispatch evidence', () => {
    const result = { ok: true, collector: {
      pendingCount: 1, busy: false, launchingMessageIds: [],
      controlPlaneBarrier: { busyRequestCount: 0, unresolvedLaunchCount: 0 },
    } };

    expect(summarizeLaunch(result)).toMatchObject({ controlPlaneBarrierPresent: true,
      busyRequestCount: 0, unresolvedLaunchCount: 0 });
    expect(launchWasDispatched(result)).toBe(false);
  });

  it('recognizes buffer drain, active launch, and newly created CP barrier evidence', () => {
    const before = { controlPlaneBarrier: { busyRequestCount: 0, unresolvedLaunchCount: 0 } };
    expect(launchWasDispatched({ collector: { pendingCount: 0 } }, before)).toBe(true);
    expect(launchWasDispatched({ collector: { pendingCount: 1, busy: true } }, before)).toBe(true);
    expect(launchWasDispatched({ collector: { pendingCount: 1, launchingMessageIds: [7] } }, before)).toBe(true);
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

  it('waits for task completion to propagate to an idle Intake before sending a follow-up', () => {
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

  it('waits for a terminal CP task while Intake finishes releasing its dispatch', async () => {
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

  it('leaves cleanup deferred if the dispatch does not become idle before the deadline', async () => {
    let now = 0;
    const result = await waitForCleanupReadiness(async () => ({ tasks: [{ status: 'done' }],
      buffer: { pendingCount: 0, busy: true, launching: 0, unresolvedLaunchCount: 0, busyRequestCount: 1 } }), {
      timeoutMs: 3_000, intervalMs: 2_000, now: () => now,
      sleep: async ms => { now += ms; },
    });

    expect(result).toMatchObject({ ready: false, tasksTerminal: true, intakeIdle: false });
  });
});

describe('production Telegram canary lane identity (E6)', () => {
  it('accepts only the pinned test bot and rejects any production bot', () => {
    expect(verifyLaneIdentity({ bot: 'ptichka_status_bot' }).botMatches).toBe(true);
    expect(verifyLaneIdentity({ bot: '@ptichka_status_bot' }).botMatches).toBe(true);
    expect(verifyLaneIdentity({ bot: 'super_personal_assistant_bot' }).botMatches).toBe(false);
    expect(verifyLaneIdentity({ bot: 'super_recruiter_assistant_bot' }).botMatches).toBe(false);
    expect(verifyLaneIdentity({}).botMatches).toBe(false);
  });

  it('records the prod-principal lane and the expected test bot', () => {
    const identity = verifyLaneIdentity({ bot: 'ptichka_status_bot' });
    expect(identity).toMatchObject({ lane: 'prod-principal', botUsername: 'ptichka_status_bot',
      expectedBotUsername: 'ptichka_status_bot', botMatches: true });
  });

  it('no longer emits the misleading PROD-E2E nonce and labels the lane prod-principal', () => {
    const readTool = name => readFileSync(fileURLToPath(new URL(`../tools/${name}`, import.meta.url)), 'utf8');
    expect(readTool('prod-principal-telegram-canary.mjs')).not.toMatch(/PROD-E2E-/);
    expect(readTool('prod-principal-telegram-canary.mjs')).toMatch(/PROD-PRINCIPAL-/);
    expect(readTool('prod-principal-telegram-canary.mjs')).toMatch(/prod-principal/);
    expect(readTool('prod-principal-resume-held-input.mjs')).not.toMatch(/PROD-E2E-/);
    expect(readTool('prod-principal-resume-held-input.mjs')).toMatch(/PROD-PRINCIPAL-/);
  });
});

describe('production Telegram canary durable-state verdict (A7)', () => {
  const durableTurn = {
    taskId: 'ut-1a39728c42c4dde793b0', taskStatus: 'done', runCount: 1, runStatus: 'success',
    sessionPersisted: true, resultPersisted: true, answerPersisted: true, answerMatchedPriorNonce: true,
    startTimePersisted: true, finishTimePersisted: true,
  };

  it('passes with full event history recorded (logging on)', () => {
    expect(durableTurnVerdict({ ...durableTurn, eventTypes: ['task_accepted', 'run_started', 'run_finished'],
      runFinishedEventPersisted: true })).toBe(true);
  });

  it('passes with no events recorded (logging disabled) — same verdict', () => {
    expect(durableTurnVerdict({ ...durableTurn, eventTypes: [], runFinishedEventPersisted: false })).toBe(true);
  });

  it('fails on missing durable state regardless of recorded events', () => {
    for (const [field, value] of [['taskStatus', 'active'], ['runStatus', 'running'], ['runCount', 0],
      ['sessionPersisted', false], ['resultPersisted', false], ['answerPersisted', false],
      ['answerMatchedPriorNonce', false], ['startTimePersisted', false], ['finishTimePersisted', false]]) {
      const broken = { ...durableTurn, [field]: value };
      expect(durableTurnVerdict({ ...broken, eventTypes: ['run_finished'], runFinishedEventPersisted: true }))
        .toBe(false);
      expect(durableTurnVerdict({ ...broken, eventTypes: [], runFinishedEventPersisted: false })).toBe(false);
    }
  });

  it('keeps event presence out of verdict gates in canary tooling', () => {
    const readTool = name => readFileSync(fileURLToPath(new URL(`../tools/${name}`, import.meta.url)), 'utf8');
    for (const name of ['prod-principal-telegram-canary.mjs', 'prod-principal-resume-held-input.mjs']) {
      expect(readTool(name)).not.toMatch(/assert\([^;\n]*historyTypes[^;\n]*includes/);
    }
  });
});
