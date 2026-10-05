import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, unlink } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const hash = value => createHash('sha256').update(value).digest('hex');
const positive = value => Number.isSafeInteger(value) && value > 0;
const reference = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(value);
const modes = ['--prepare', '--append-approved', '--observe-collector', '--launch-approved', '--observe'];

function requireProof(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { safeCode: code });
}

function httpsBase(value) {
  let url;
  try { url = new URL(value); } catch { requireProof(false, 'HTTPS_BASE_REQUIRED'); }
  requireProof(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
    && url.pathname === '/', 'HTTPS_BASE_REQUIRED');
  return url.origin;
}

export function readExistingUxConfig(input) {
  requireProof(input.fixture === true && reference(input.caseId), 'EXPLICIT_FIXTURE_REQUIRED');
  requireProof(reference(input.botUsername) && reference(input.profileId) && reference(input.principalId), 'SCOPED_IDENTITY_REQUIRED');
  requireProof(Number.isSafeInteger(input.chatId) && input.chatId !== 0 && positive(input.userId)
    && (input.threadId == null || positive(input.threadId)), 'EXPLICIT_DESTINATION_REQUIRED');
  requireProof(typeof input.webhookSecret === 'string' && input.webhookSecret.length > 0
    && ((typeof input.principalSignature === 'string' && /^[a-f0-9]{64}$/i.test(input.principalSignature))
      || (typeof input.apiKey === 'string' && input.apiKey.length > 0)), 'PRIVATE_AUTH_REQUIRED');
  requireProof(Array.isArray(input.messages) && input.messages.length > 0 && input.messages.length <= 10, 'BOUNDED_MESSAGES_REQUIRED');
  for (const message of input.messages) {
    requireProof(positive(message.updateId) && positive(message.messageId) && positive(message.date)
      && typeof message.text === 'string' && message.text.startsWith(`[Integration fixture ${input.caseId}]`)
      && message.text === message.text.trim() && Buffer.byteLength(message.text) <= 16000, 'FROZEN_FIXTURE_MESSAGE_REQUIRED');
  }
  requireProof(new Set(input.messages.map(message => message.updateId)).size === input.messages.length
    && new Set(input.messages.map(message => message.messageId)).size === input.messages.length
    && positive(input.callbackUpdateId) && !input.messages.some(message => message.updateId === input.callbackUpdateId)
    && reference(input.callbackId) && input.callbackId.length <= 64, 'UNIQUE_FROZEN_IDS_REQUIRED');
  requireProof(isAbsolute(input.checkpointFile ?? ''), 'PRIVATE_CHECKPOINT_PATH_REQUIRED');
  requireProof([0, 1].includes(input.expectedRunCount), 'EXPLICIT_ENGINE_EXPECTATION_REQUIRED');
  const requestTimeoutMs = input.requestTimeoutMs ?? 60000;
  const overallTimeoutMs = input.overallTimeoutMs ?? 900000;
  const pollIntervalMs = input.pollIntervalMs ?? 1000;
  requireProof(positive(requestTimeoutMs) && requestTimeoutMs <= 60000 && positive(overallTimeoutMs)
    && overallTimeoutMs >= requestTimeoutMs && overallTimeoutMs <= 900000 && positive(pollIntervalMs)
    && pollIntervalMs <= 10000, 'BOUNDED_TIMEOUTS_REQUIRED');
  const config = { ...input, gatewayUrl: httpsBase(input.gatewayUrl), controlPlaneUrl: httpsBase(input.controlPlaneUrl),
    threadId: input.threadId ?? null, requestTimeoutMs, overallTimeoutMs, pollIntervalMs };
  requireProof(config.gatewayUrl !== config.controlPlaneUrl, 'DISTINCT_TRANSPORTS_REQUIRED');
  const messageIds = input.messages.map(message => message.messageId).sort((first, second) => first - second);
  const batchRequestId = `tg-${hash(`${input.chatId}:${messageIds.join(',')}`)}`;
  const scope = `${input.botUsername}:${input.profileId}:${input.chatId}:${config.threadId ?? ''}`;
  config.requestId = `tgcp-${hash(`${scope}:${batchRequestId}`)}`;
  config.taskId = `ut-${hash(`${input.profileId}\0${config.requestId}`).slice(0, 20)}`;
  config.updateBodies = input.messages.map(message => JSON.stringify({ update_id: message.updateId,
    message: { message_id: message.messageId, date: message.date, chat: { id: input.chatId,
      type: input.chatId > 0 ? 'private' : 'supergroup' }, from: { id: input.userId, is_bot: false },
    text: message.text, ...(config.threadId == null ? {} : { message_thread_id: config.threadId, is_topic_message: true }) } }));
  config.callbackTemplate = { update_id: input.callbackUpdateId, callback_query: {
    id: input.callbackId, from: { id: input.userId, is_bot: false }, data: 'intake_run',
    message: { message_id: null, date: input.messages[0].date,
      chat: { id: input.chatId, type: input.chatId > 0 ? 'private' : 'supergroup' },
      ...(config.threadId == null ? {} : { message_thread_id: config.threadId, is_topic_message: true }) } } };
  config.fingerprint = hash(JSON.stringify([config.gatewayUrl, config.controlPlaneUrl, scope, input.principalId,
    hash(input.webhookSecret), hash(input.principalSignature ?? ''), hash(input.apiKey ?? ''), config.updateBodies,
    input.callbackUpdateId, input.callbackId, input.expectedRunCount]));
  return config;
}

async function privateDirectory(file) {
  const directory = await lstat(dirname(file));
  requireProof(directory.isDirectory() && !directory.isSymbolicLink() && (directory.mode & 0o777) === 0o700, 'PRIVATE_DIRECTORY_REQUIRED');
}

async function privateHandle(file, flags) {
  const handle = await open(file, flags | constants.O_NOFOLLOW, 0o600);
  try {
    const metadata = await handle.stat();
    requireProof(metadata.isFile() && metadata.nlink === 1 && (metadata.mode & 0o777) === 0o600
      && metadata.size <= 262144, 'PRIVATE_BOUNDED_FILE_REQUIRED');
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

async function save(handle, checkpoint) {
  const bytes = Buffer.from(JSON.stringify(checkpoint) + '\n');
  requireProof(bytes.length <= 262144, 'CHECKPOINT_TOO_LARGE');
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset, offset);
    requireProof(result.bytesWritten > 0, 'CHECKPOINT_WRITE_FAILED');
    offset += result.bytesWritten;
  }
  await handle.truncate(bytes.length);
  await handle.sync();
}

async function privateJson(handle) {
  try { return JSON.parse(await handle.readFile('utf8')); }
  catch { requireProof(false, 'PRIVATE_JSON_INVALID'); }
}

export async function loadExistingUxConfig(file) {
  requireProof(isAbsolute(file ?? ''), 'PRIVATE_BINDINGS_PATH_REQUIRED');
  await privateDirectory(file);
  const handle = await privateHandle(file, constants.O_RDONLY);
  try {
    const config = readExistingUxConfig(await privateJson(handle));
    requireProof(config.checkpointFile !== file && config.checkpointFile + '.lock' !== file, 'DISTINCT_PRIVATE_FILES_REQUIRED');
    return config;
  } finally { await handle.close(); }
}

export function verifyExistingUxDelivery(status, deliveries, config, receipt) {
  const task = status?.taskStore;
  requireProof(receipt?.userTaskId === config.taskId && receipt.requestId === config.requestId
    && receipt.profileId === config.profileId && receipt.durable === true, 'CP_RECEIPT_SCOPE_MISMATCH');
  requireProof(task?.id === config.taskId
    && task.profile_id === config.profileId && task.generation === 1, 'CP_TASK_SCOPE_MISMATCH');
  requireProof(task.status === 'done' && task.stage === 'finished', 'CP_SUCCESS_REQUIRED');
  requireProof(Array.isArray(status.runs) && status.runs.length === config.expectedRunCount, 'ENGINE_ATTEMPT_COUNT_MISMATCH');
  for (const run of status.runs) requireProof(run.generation === 1 && run.status === 'done'
    && reference(run.id) && reference(run.session_id), 'CANONICAL_RUN_REQUIRED');
  const answer = typeof task.result === 'string' ? task.result : task.result?.answer;
  requireProof(typeof answer === 'string' && answer.trim().length > 0, 'PERSISTED_ANSWER_REQUIRED');
  const terminal = deliveries?.terminal;
  requireProof(deliveries.receipt == null && terminal?.userTaskId === config.taskId
    && terminal.deliveryId === `terminal:${config.taskId}:g1` && terminal.generation === 1
    && terminal.status === 'sent' && terminal.attempts === 1 && positive(terminal.providerMessageId)
    && terminal.chatId === config.chatId && terminal.threadId === config.threadId && terminal.legacyStatus == null,
  'SINGLE_SCOPED_TERMINAL_DELIVERY_REQUIRED');
  return { taskId: config.taskId, generation: 1, attemptCount: status.runs.length,
    answerHash: hash(answer), terminalAttempts: 1, providerMessageId: terminal.providerMessageId };
}

export async function operateExistingUx(mode, config, options = {}) {
  requireProof(modes.includes(mode), 'EXPLICIT_MODE_REQUIRED');
  await privateDirectory(config.checkpointFile);
  let handle;
  let lock;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? (duration => new Promise(resolveSleep => setTimeout(resolveSleep, duration)));
  const deadline = Date.now() + config.overallTimeoutMs;
  let checkpoint;
  let validated = false;
  let boundary = 'private_checkpoint';
  try {
    lock = await privateHandle(config.checkpointFile + '.lock', constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    handle = await privateHandle(config.checkpointFile, mode === '--prepare'
      ? constants.O_RDWR | constants.O_CREAT | constants.O_EXCL : constants.O_RDWR);
    if (mode === '--prepare') {
      checkpoint = { version: 1, phase: 'prepared', fingerprint: config.fingerprint, taskId: config.taskId,
        updateBodies: config.updateBodies, updateHashes: config.updateBodies.map(hash),
        callbackTemplate: config.callbackTemplate, acknowledged: 0 };
      await save(handle, checkpoint);
      return { outcome: 'prepared', taskId: config.taskId, bodyHashes: checkpoint.updateHashes, httpCalls: 0 };
    }
    checkpoint = await privateJson(handle);
    requireProof(checkpoint.version === 1 && checkpoint.fingerprint === config.fingerprint && checkpoint.taskId === config.taskId
      && JSON.stringify(checkpoint.updateBodies) === JSON.stringify(config.updateBodies)
      && JSON.stringify(checkpoint.callbackTemplate) === JSON.stringify(config.callbackTemplate)
      && JSON.stringify(checkpoint.updateHashes) === JSON.stringify(config.updateBodies.map(hash)), 'FROZEN_IDENTITY_MISMATCH');
    validated = true;
    async function request(base, path, method = 'GET', body, allowAbsent = false) {
      boundary = `${base === config.gatewayUrl ? 'gateway' : 'cp'}:${method} ${path.split('?')[0]}`;
      const remaining = deadline - Date.now();
      requireProof(remaining > 0, 'OBSERVATION_DEADLINE');
      const headers = base === config.gatewayUrl
        ? { 'x-telegram-bot-api-secret-token': config.webhookSecret }
        : { 'x-principal': config.principalId,
          ...(config.principalSignature ? { 'x-principal-sig': config.principalSignature } : {}),
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) };
      let reader;
      try {
        const response = await fetchImpl(`${base}${path}`, { method, headers: { ...headers, 'content-type': 'application/json' },
          body, redirect: 'error', signal: AbortSignal.timeout(Math.min(config.requestTimeoutMs, remaining)) });
        reader = response.body?.getReader();
        const chunks = [];
        let bytes = 0;
        if (reader) while (true) {
          const item = await reader.read();
          if (item.done) break;
          bytes += item.value.byteLength;
          requireProof(bytes <= 262144, 'HTTP_BODY_TOO_LARGE');
          chunks.push(Buffer.from(item.value));
        }
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (allowAbsent && response.status === 404) {
          requireProof(value.name === 'TaskNotFoundError' && value.error === `task not found: ${config.taskId}`, 'SCOPED_ABSENCE_REQUIRED');
          return null;
        }
        requireProof(response.ok, `HTTP_${response.status}`);
        return value;
      } catch (error) {
        if (error.safeCode) throw error;
        requireProof(false, 'TRANSPORT_OR_JSON_UNKNOWN');
      } finally {
        if (reader) { try { await reader.cancel(); } catch {} reader.releaseLock(); }
      }
    }
    const cpStatus = () => request(config.controlPlaneUrl, '/status', 'POST', JSON.stringify({ taskId: config.taskId }), true);
    const collectorPath = `/collector-state?chatId=${encodeURIComponent(config.chatId)}${config.threadId == null ? '' : `&threadId=${config.threadId}`}`;
    async function health() {
      const result = await request(config.gatewayUrl, '/health');
      requireProof(result.status === 'ok' && result.mode === 'existing-ux-control-plane', 'NEW_EXISTING_UX_GATEWAY_REQUIRED');
    }
    async function collectorProof() {
      const state = await request(config.gatewayUrl, collectorPath);
      requireProof(state.busy === false && Array.isArray(state.launching) && state.launching.length === 0
        && Array.isArray(state.retryBatch) && state.retryBatch.length === 0 && !state.stopped, 'PRELAUNCH_QUIESCENCE_REQUIRED');
      requireProof(await cpStatus() === null, 'PRELAUNCH_TASK_ALREADY_ADMITTED');
      const expected = config.messages.map(message => message.messageId).sort((first, second) => first - second);
      requireProof(Array.isArray(state.buf) && JSON.stringify(state.buf.map(item => item.messageId).sort((first, second) => first - second))
        === JSON.stringify(expected) && state.buf.every(item => item.hasText && !item.mediaPending), 'EXACT_BUFFER_REQUIRED');
      requireProof(!['sending', 'unknown'].includes(state.collectorDelivery?.state), 'COLLECTOR_PROVIDER_OUTCOME_UNKNOWN');
      if (!positive(state.collectorMsgId)) return null;
      requireProof(state.collectorDelivery?.state === 'sent' && state.collectorDelivery.messageId === state.collectorMsgId,
        'ACTUAL_PROVIDER_COLLECTOR_REQUIRED');
      requireProof(Number.isFinite(state.debounceExpiresAt) && state.debounceExpiresAt > Date.now(), 'PRELAUNCH_WINDOW_EXPIRED');
      return { collectorId: state.collectorMsgId, zeroAdmission: true, taskId: config.taskId, observedAt: Date.now() };
    }
    if (mode === '--append-approved') {
      requireProof(config.approved === 'yes' && checkpoint.phase === 'prepared', 'APPROVAL_AND_FRESH_PREPARE_REQUIRED');
      await health();
      const empty = await request(config.gatewayUrl, collectorPath);
      requireProof(empty.busy === false && ['buf', 'launching', 'retryBatch'].every(key => Array.isArray(empty[key]) && empty[key].length === 0)
        && empty.collectorMsgId == null && empty.collectorDelivery == null && !empty.stopped, 'EMPTY_OWN_COLLECTOR_REQUIRED');
      requireProof(await cpStatus() === null, 'PRELAUNCH_TASK_ALREADY_ADMITTED');
      for (const body of checkpoint.updateBodies) {
        checkpoint.phase = 'append_unknown';
        await save(handle, checkpoint);
        const result = await request(config.gatewayUrl, '/webhook', 'POST', body);
        requireProof(result.ok === true && result.duplicate !== true && result.unsupported !== true, 'FRESH_APPEND_ACK_REQUIRED');
        checkpoint.acknowledged += 1;
        await save(handle, checkpoint);
      }
      checkpoint.phase = 'appended';
      await save(handle, checkpoint);
      return { outcome: 'appended', taskId: config.taskId, messageCount: checkpoint.acknowledged };
    }
    if (mode === '--observe-collector') {
      requireProof(['appended', 'append_unknown', 'collector_ready'].includes(checkpoint.phase), 'APPENDED_CHECKPOINT_REQUIRED');
      await health();
      while (Date.now() < deadline) {
        const proof = await collectorProof();
        if (proof) {
          if (checkpoint.prelaunch) requireProof(proof.collectorId === checkpoint.prelaunch.collectorId, 'COLLECTOR_ID_CHANGED');
          checkpoint.prelaunch = proof;
          checkpoint.phase = 'collector_ready';
          await save(handle, checkpoint);
          return { outcome: 'collector_ready', taskId: config.taskId, scopedZeroAdmission: true };
        }
        await sleep(config.pollIntervalMs);
      }
      requireProof(false, 'OBSERVATION_DEADLINE');
    }
    if (mode === '--launch-approved') {
      requireProof(config.approved === 'yes' && checkpoint.phase === 'collector_ready', 'APPROVED_COLLECTOR_CHECKPOINT_REQUIRED');
      await health();
      const proof = await collectorProof();
      requireProof(proof?.collectorId === checkpoint.prelaunch?.collectorId, 'COLLECTOR_ID_CHANGED');
      checkpoint.callbackBody = JSON.stringify({ ...checkpoint.callbackTemplate, callback_query: {
        ...checkpoint.callbackTemplate.callback_query,
        message: { ...checkpoint.callbackTemplate.callback_query.message, message_id: proof.collectorId } } });
      checkpoint.callbackHash = hash(checkpoint.callbackBody);
      checkpoint.phase = 'launch_unknown';
      await save(handle, checkpoint);
      const result = await request(config.gatewayUrl, '/webhook', 'POST', checkpoint.callbackBody);
      requireProof(result.ok === true && result.unsupported !== true, 'CALLBACK_ACK_REQUIRED');
      checkpoint.phase = 'launched';
      await save(handle, checkpoint);
      return { outcome: 'launched', taskId: config.taskId, next: 'read_only_observe' };
    }
    requireProof(['launch_unknown', 'launched', 'observed', 'passed'].includes(checkpoint.phase), 'LAUNCH_CHECKPOINT_REQUIRED');
    requireProof(checkpoint.callbackBody && hash(checkpoint.callbackBody) === checkpoint.callbackHash, 'FROZEN_CALLBACK_REQUIRED');
    requireProof(checkpoint.prelaunch?.zeroAdmission === true && checkpoint.prelaunch.taskId === config.taskId
      && positive(checkpoint.prelaunch.collectorId), 'PRELAUNCH_WITNESS_REQUIRED');
    requireProof(checkpoint.callbackBody === JSON.stringify({ ...checkpoint.callbackTemplate, callback_query: {
      ...checkpoint.callbackTemplate.callback_query,
      message: { ...checkpoint.callbackTemplate.callback_query.message, message_id: checkpoint.prelaunch.collectorId } } }),
    'FROZEN_CALLBACK_REQUIRED');
    let firstProof;
    while (Date.now() < deadline) {
      const status = await cpStatus();
      if (status) {
        const task = status.taskStore;
        requireProof(task?.id === config.taskId && task.profile_id === config.profileId
          && task.generation === 1, 'CP_TASK_SCOPE_MISMATCH');
        requireProof(!['failed', 'cancelled'].includes(task.status), 'CP_TERMINAL_NOT_SUCCESS');
        if (task.status === 'done') {
          const deliveries = await request(config.gatewayUrl, `/deliveries/${encodeURIComponent(config.taskId)}`);
          if (deliveries.terminal?.status === 'sent') {
            const receipt = await request(config.controlPlaneUrl, '/receipt', 'POST', JSON.stringify({ taskId: config.taskId }));
            const proof = verifyExistingUxDelivery(status, deliveries, config, receipt);
            if (firstProof) {
              requireProof(JSON.stringify(proof) === JSON.stringify(firstProof), 'TERMINAL_EVIDENCE_CHANGED');
              checkpoint.phase = 'passed';
              checkpoint.proof = proof;
              await save(handle, checkpoint);
              return { outcome: 'pass', scopedZeroAdmission: checkpoint.prelaunch?.zeroAdmission === true, ...proof };
            }
            firstProof = proof;
          } else requireProof(!['unknown', 'dead', 'quarantined'].includes(deliveries.terminal?.status), 'TERMINAL_DELIVERY_UNRESOLVED');
        }
        checkpoint.phase = 'observed';
        checkpoint.observed = { status: task.status, generation: task.generation, at: Date.now() };
        await save(handle, checkpoint);
      }
      await sleep(config.pollIntervalMs);
    }
    requireProof(false, 'OBSERVATION_DEADLINE');
  } catch (error) {
    if (validated && handle && checkpoint) {
      checkpoint.failure = { code: error.safeCode ?? 'PRIVATE_OPERATOR_ERROR', boundary,
        phase: checkpoint.phase, at: Date.now() };
      try { await save(handle, checkpoint); } catch {}
    }
    throw error;
  } finally {
    if (handle) await handle.close();
    if (lock) { await lock.close(); await unlink(config.checkpointFile + '.lock'); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    requireProof(process.argv.length === 4, 'EXPLICIT_MODE_AND_PRIVATE_BINDINGS_REQUIRED');
    const config = await loadExistingUxConfig(process.argv[3]);
    const proof = await operateExistingUx(process.argv[2], config);
    process.stdout.write(JSON.stringify(proof) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ outcome: 'blocked', code: error.safeCode ?? 'PRIVATE_OPERATOR_ERROR' }) + '\n');
    process.exitCode = 1;
  }
}
