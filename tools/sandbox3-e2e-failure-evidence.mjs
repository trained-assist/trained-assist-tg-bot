const CODE = /^[A-Za-z0-9_.:-]{1,80}$/;
const ID = /^[A-Za-z0-9_.:-]{1,180}$/;

function text(value, pattern = CODE) {
  return typeof value === 'string' && pattern.test(value) ? value : null;
}

function integer(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Keep actionable E2E failure facts while excluding prompts, results and credentials. */
export function summarizeSandbox3E2eFailure(value = {}) {
  const summary = { stage: text(value.stage) ?? 'unknown' };

  if (value.task && typeof value.task === 'object') {
    summary.task = {
      id: text(value.task.id, ID),
      status: text(value.task.status),
      generation: integer(value.task.generation),
      goalContainsExpectedInput: typeof value.task.goalContainsExpectedInput === 'boolean' ? value.task.goalContainsExpectedInput : null,
      inputItemCount: integer(value.task.inputItemCount),
      artifactManifestPersisted: typeof value.task.artifactManifestPersisted === 'boolean' ? value.task.artifactManifestPersisted : null,
      expectedLineBreaks: integer(value.task.expectedLineBreaks),
      persistedLineBreaks: integer(value.task.persistedLineBreaks),
    };
  }

  if (value.routing && typeof value.routing === 'object') {
    summary.routing = {
      route: text(value.routing.route),
      mode: text(value.routing.mode),
      reasonCode: text(value.routing.reasonCode),
      providerCode: text(value.routing.providerCode),
      capabilityId: text(value.routing.capabilityId),
      outcome: text(value.routing.outcome),
      needsExecutor: typeof value.routing.needsExecutor === 'boolean' ? value.routing.needsExecutor : null,
      replyAllowed: typeof value.routing.replyAllowed === 'boolean' ? value.routing.replyAllowed : null,
      continuationRequested: typeof value.routing.continuationRequested === 'boolean'
        ? value.routing.continuationRequested : null,
    };
  }

  if (value.executions && typeof value.executions === 'object') {
    const items = Array.isArray(value.executions.items) ? value.executions.items : [];
    summary.executions = {
      count: integer(value.executions.count),
      items: items.slice(0, 8).map(item => ({
        id: text(item?.id, ID),
        status: text(item?.status),
        engine: text(item?.engine),
        generation: integer(item?.generation),
        runIdPresent: typeof item?.runId === 'string' && ID.test(item.runId),
        errorClass: text(item?.errorClass),
        runnerErrorCode: text(item?.runnerErrorCode),
      })),
    };
  }

  if (value.answer && typeof value.answer === 'object') {
    summary.answer = {
      matchesChallenge: typeof value.answer.matchesChallenge === 'boolean' ? value.answer.matchesChallenge : null,
      resultCharacterCount: integer(value.answer.resultCharacterCount),
    };
  }

  if (value.failure && typeof value.failure === 'object') {
    summary.failure = { code: text(value.failure.code) };
  }

  if (value.artifactExport && typeof value.artifactExport === 'object') {
    summary.artifactExport = {
      expectedFileExportsPresent: typeof value.artifactExport.expectedFileExportsPresent === 'boolean'
        ? value.artifactExport.expectedFileExportsPresent : null,
      exportEventCount: integer(value.artifactExport.exportEventCount),
      resultManifestCount: integer(value.artifactExport.resultManifestCount),
      runnerResultManifestValid: typeof value.artifactExport.runnerResultManifestValid === 'boolean'
        ? value.artifactExport.runnerResultManifestValid : null,
      manifestCount: integer(value.artifactExport.manifestCount),
      manifestMetadataValid: typeof value.artifactExport.manifestMetadataValid === 'boolean'
        ? value.artifactExport.manifestMetadataValid : null,
      matchingTaskManifest: typeof value.artifactExport.matchingTaskManifest === 'boolean'
        ? value.artifactExport.matchingTaskManifest : null,
      persistenceState: text(value.artifactExport.persistenceState),
    };
  }

  if (value.delivery && typeof value.delivery === 'object') {
    summary.delivery = {
      status: text(value.delivery.status),
      attempts: integer(value.delivery.attempts),
      providerMessageIdPresent: typeof value.delivery.providerMessageIdPresent === 'boolean'
        ? value.delivery.providerMessageIdPresent : null,
      controlPlaneState: text(value.delivery.controlPlaneState),
      controlPlaneRows: integer(value.delivery.controlPlaneRows),
    };
  }

  return summary;
}
