import { describe, expect, it } from 'vitest';
import { summarizeSandbox3E2eFailure } from '../tools/sandbox3-e2e-failure-evidence.mjs';

describe('sandbox3 E2E failure evidence', () => {
  it('keeps route, Runner, answer and delivery facts without retaining user or model text', () => {
    const result = summarizeSandbox3E2eFailure({
      stage: 'answer_validation',
      task: { id: 'ut-safe.1', status: 'done', generation: 1, goalContainsExpectedInput: true,
        artifactManifestPersisted: true,
        inputItemCount: 1, expectedLineBreaks: 0, persistedLineBreaks: 0, goal: 'private prompt' },
      routing: { route: 'agent', mode: 'ai-agent-job', reasonCode: 'COMMUNICATION_FALLBACK',
        providerCode: 'no_matching_option', capabilityId: 'agent', outcome: 'dispatched',
        needsExecutor: true, replyAllowed: false, continuationRequested: true, prompt: 'private prompt' },
      executions: { count: 1, items: [{ id: 'attempt-1', status: 'success', engine: 'cloudflare-workflows',
        generation: 1, runId: 'run_abc.1', errorClass: null, runnerErrorCode: null, result: 'private model output' }] },
      answer: { matchesChallenge: false, resultCharacterCount: 27, text: 'private model output' },
      artifactExport: { expectedMarkdownExported: true, expectedScreenshotExported: false,
        manifestCount: 1, manifestMetadataValid: false, rawArtifactRef: 'private storage key' },
      delivery: { status: 'unknown', attempts: 2, providerMessageIdPresent: false,
        controlPlaneState: 'not_required', controlPlaneRows: 0, chatId: 'private chat' },
    });

    expect(result).toEqual({
      stage: 'answer_validation',
      task: { id: 'ut-safe.1', status: 'done', generation: 1, goalContainsExpectedInput: true,
        inputItemCount: 1, artifactManifestPersisted: true, expectedLineBreaks: 0, persistedLineBreaks: 0 },
      routing: { route: 'agent', mode: 'ai-agent-job', reasonCode: 'COMMUNICATION_FALLBACK',
        providerCode: 'no_matching_option', capabilityId: 'agent', outcome: 'dispatched',
        needsExecutor: true, replyAllowed: false, continuationRequested: true },
      executions: { count: 1, items: [{ id: 'attempt-1', status: 'success', engine: 'cloudflare-workflows',
        generation: 1, runIdPresent: true, errorClass: null, runnerErrorCode: null }] },
      answer: { matchesChallenge: false, resultCharacterCount: 27 },
      artifactExport: { expectedMarkdownExported: true, expectedScreenshotExported: false,
        manifestCount: 1, manifestMetadataValid: false },
      delivery: { status: 'unknown', attempts: 2, providerMessageIdPresent: false,
        controlPlaneState: 'not_required', controlPlaneRows: 0 },
    });
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('drops malformed or unapproved values from failure evidence', () => {
    expect(summarizeSandbox3E2eFailure({ stage: 'bad stage with spaces', task: { id: 'secret/token', status: 'running' },
      routing: { route: 'some raw prompt\ntext', reasonCode: 'x'.repeat(100) } })).toEqual({
      stage: 'unknown',
      task: { id: null, status: 'running', generation: null, goalContainsExpectedInput: null,
        inputItemCount: null, artifactManifestPersisted: null, expectedLineBreaks: null, persistedLineBreaks: null },
      routing: { route: null, mode: null, reasonCode: null, providerCode: null, capabilityId: null,
        outcome: null, needsExecutor: null, replyAllowed: null, continuationRequested: null },
    });
  });

  it('keeps only safe Runner rejection codes from arbitrary error text', () => {
    expect(summarizeSandbox3E2eFailure({ executions: { count: 1, items: [
      { errorClass: 'runner_rejected', runnerErrorCode: 'INVALID_INGRESS_MANIFEST', errorText: 'secret user prompt' },
      { errorClass: 'runner_rejected', runnerErrorCode: 'not a code: token=secret' },
    ] } })).toEqual({ stage: 'unknown', executions: { count: 1, items: [
      { id: null, status: null, engine: null, generation: null, runIdPresent: false,
        errorClass: 'runner_rejected', runnerErrorCode: 'INVALID_INGRESS_MANIFEST' },
      { id: null, status: null, engine: null, generation: null, runIdPresent: false,
        errorClass: 'runner_rejected', runnerErrorCode: null },
    ] } });
  });
});
