import { describe, expect, it } from 'vitest';
import { summarizeStopDiagnostics } from '../tools/sandbox3-stop-diagnostics.mjs';

describe('sandbox3 stop diagnostics', () => {
  it('keeps only bounded CP stop codes and states', () => {
    const result = summarizeStopDiagnostics({
      replyConfirmed: false,
      inspectStatus: 200,
      inspectPayload: { snapshot: { entries: { cpStopWindow: {
        pending: true,
        unresolved: true,
        stopConfirmed: false,
        reason: 'native_stop_pending',
        groups: [{ unresolved: true, stopConfirmed: false, reason: 'native_stop_pending', tasks: [
          { status: 'running', attempts: [{ status: 'pending', runId: 'private-run-id' }] },
        ] }],
        text: 'must never be copied to evidence',
      } } } },
      taskEvidence: { status: 'running', generation: 1,
        executions: [{ status: 'running', engine: 'eu-vm-agent-run', generation: 1, sessionId: 'secret-session' }],
        events: [{ eventType: 'runner.cancel', reasonCode: 'native_stop_unknown', stage: 'cancel',
          errorClass: 'network', where: 'runner_adapter', raw: 'private response body' }] },
    });

    expect(result).toEqual({
      replyConfirmed: false,
      inspect: { available: true, status: 200, error: null, reason: null },
      stopWindow: { pending: true, unresolved: true, stopConfirmed: false, reason: 'native_stop_pending',
        groupCount: 1, groups: [{ unresolved: true, stopConfirmed: false, reason: 'native_stop_pending',
          taskCount: 1, tasks: [{ status: 'running', attemptCount: 1, attemptStates: ['pending'] }] }] },
      task: { status: 'running', generation: 1,
        executions: [{ status: 'running', engine: 'eu-vm-agent-run', generation: 1 }],
        events: [{ eventType: 'runner.cancel', reasonCode: 'native_stop_unknown', stage: 'cancel',
          errorClass: 'network', where: 'runner_adapter' }] },
    });
    expect(JSON.stringify(result)).not.toContain('private-run-id');
    expect(JSON.stringify(result)).not.toContain('must never');
    expect(JSON.stringify(result)).not.toContain('secret-session');
    expect(JSON.stringify(result)).not.toContain('private response body');
  });

  it('reports a missing/inaccessible stop window without copying upstream text', () => {
    expect(summarizeStopDiagnostics({ replyConfirmed: false, inspectStatus: 409,
      inspectPayload: { error: 'active stop window details', reason: 'control_plane_unavailable' } })).toEqual({
      replyConfirmed: false,
      inspect: { available: false, status: 409, error: null, reason: 'control_plane_unavailable' },
      stopWindow: null,
      task: null,
    });
  });
});
