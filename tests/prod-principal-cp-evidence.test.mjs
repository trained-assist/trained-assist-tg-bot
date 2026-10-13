import { describe, expect, it } from 'vitest';
import { summarizeCpRouting } from '../tools/prod-principal-cp-evidence.mjs';

describe('production E2E CP evidence', () => {
  it('summarizes route and result kind without copying prompts or answers', () => {
    const prompt = 'private task prompt';
    const answer = 'private answer text';
    const summary = summarizeCpRouting({
      result: { ok: true, mode: 'quick_answer', answer, privateField: answer,
        quickAnswer: { id: 'system_health', version: 1 } },
      history: [{ kind: 'routing.selected', payload: JSON.stringify({
        decisionId: 'decision-1',
        decision: { route: 'deterministic', mode: 'quick_answer', outcome: 'reply',
          reasonCode: 'system_health', needsExecutor: false },
        continuation: null, workOrder: null, reply: { text: answer }, goal: prompt,
      }) }],
      goal: prompt,
    });

    expect(summary).toEqual({
      routingSelectionPersisted: true,
      decisionIdPresent: true,
      route: 'deterministic',
      mode: 'quick_answer',
      outcome: 'reply',
      reasonCode: 'system_health',
      needsExecutor: false,
      continuationPresent: false,
      workOrderPresent: false,
      replyPresent: true,
      resultOk: true,
      resultMode: 'quick_answer',
      resultStatus: null,
      resultReasonCode: null,
      quickAnswerCapabilityId: 'system_health',
      quickAnswerCapabilityVersion: 1,
    });
    expect(JSON.stringify(summary)).not.toContain(prompt);
    expect(JSON.stringify(summary)).not.toContain(answer);
  });

  it('redacts unsafe route codes and tolerates malformed event payloads', () => {
    expect(summarizeCpRouting({
      result: { answer: 'secret' },
      history: [{ kind: 'routing.selected', payload: '{broken' }, { kind: 'routing.selected', payload: JSON.stringify({
        decision: { route: 'private route text', reasonCode: 'secret reason', needsExecutor: 'unknown' },
      }) }],
    })).toEqual({
      routingSelectionPersisted: true,
      decisionIdPresent: false,
      route: null,
      mode: null,
      outcome: null,
      reasonCode: null,
      needsExecutor: null,
      continuationPresent: false,
      workOrderPresent: false,
      replyPresent: false,
      resultOk: null,
      resultMode: null,
      resultStatus: null,
      resultReasonCode: null,
      quickAnswerCapabilityId: null,
      quickAnswerCapabilityVersion: null,
    });
    expect(summarizeCpRouting({ history: [{ kind: 'routing.selected', payload: '{broken' }] }).route).toBeNull();
  });
});
