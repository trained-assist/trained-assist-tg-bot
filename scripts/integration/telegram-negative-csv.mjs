import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, unlink } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadBindings, readLiveConfig, serializeUpdate } from './telegram-v1-smoke.mjs';
import { ingressRefOf } from '../../src/sandbox-tg/profile.js';

export const NEGATIVE_TEXT = [
  'Controlled negative CSV publisher contract test. Download and read only this pinned input:',
  'https://raw.githubusercontent.com/vovalikessmoothy-png/opencode-gha-runner/a4acd6c1f428d56abb1fdb6610889528f3049fb5/fixtures/integration-v1/category-source.csv',
  'Intentionally DO NOT create, write, copy, rename or produce outputs/category-results.csv or any substitute output or manifest.',
  'If the output already exists, do not modify it; report that this negative test is inconclusive.',
  'Finish normally after reading and explicitly state intentional omission. Do not repair or bypass the mandatory-output failure.',
  'Do not change existing repository files. No Google, Sheets, Drive, MCP or external-user actions. Only the pinned CSV download is permitted.',
].join('\n');

const digest = value => createHash('sha256').update(value).digest('hex');
const reference = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(value);
function check(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { safeCode: code });
}

export function readNegativeConfig(bindings) {
  const config = readLiveConfig(bindings);
  check(config.text === NEGATIVE_TEXT, 'EXACT_NEGATIVE_TEXT_REQUIRED');
  check(typeof bindings.INTEGRATION_UPDATE_FILE === 'string' && config.savedUpdateBody !== undefined, 'SAVED_UPDATE_REQUIRED');
  check(isAbsolute(bindings.NEGATIVE_CHECKPOINT_FILE ?? ''), 'PRIVATE_CHECKPOINT_PATH_REQUIRED');
  check(bindings.NEGATIVE_CHECKPOINT_FILE !== bindings.INTEGRATION_UPDATE_FILE, 'DISTINCT_CHECKPOINT_REQUIRED');
  check(reference(bindings.NEGATIVE_CUTOVER_ID), 'EXPECTED_CUTOVER_REQUIRED');
  const requestId = `${ingressRefOf(config.username, config.chatId, config.messageId, config.threadId)}:u${config.updateId}`;
  return { ...config, checkpointFile: bindings.NEGATIVE_CHECKPOINT_FILE,
    admissionFile: bindings.NEGATIVE_ADMISSION_FILE, cutoverId: bindings.NEGATIVE_CUTOVER_ID,
    approved: bindings.NEGATIVE_AUTODELIVERY_APPROVED === 'yes',
    taskId: `ut-${digest(`${config.profile}\0${requestId}`).slice(0, 20)}` };
}

function identity(config) {
  return { taskId: config.taskId, bodyHash: digest(serializeUpdate(config)),
    scopeHash: digest(JSON.stringify([config.gatewayUrl, config.controlPlaneUrl, config.profile, config.principal,
      config.username, config.cutoverId])) };
}

async function privateText(file, maximum = 262144) {
  const metadata = await lstat(file);
  check(metadata.isFile() && !metadata.isSymbolicLink() && (metadata.mode & 0o777) === 0o600 && metadata.size <= maximum,
    'PRIVATE_BOUNDED_FILE_REQUIRED');
  const text = await readFile(file, 'utf8');
  check(Buffer.byteLength(text) <= maximum, 'PRIVATE_FILE_TOO_LARGE');
  return text;
}

async function save(handle, value) {
  const bytes = Buffer.from(JSON.stringify(value) + '\n');
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset, offset);
    check(result.bytesWritten > 0, 'CHECKPOINT_WRITE_FAILED');
    offset += result.bytesWritten;
  }
  await handle.truncate(bytes.length);
  await handle.sync();
}

export function verifyNegative(status, deliveries, config, journal) {
  const row = status?.taskStore;
  check(row?.id === config.taskId, 'TASK_ID_MISMATCH');
  check(row.generation === 1, 'GENERATION_MUST_BE_ONE');
  check(row.status === 'failed' && row.stage === 'finished', 'EXPECTED_TERMINAL_FAILED');
  if (row.profile_id != null) check(row.profile_id === config.profile, 'PROFILE_MISMATCH');
  check(row.result?.failure?.code === 'ARTIFACTS_MISSING', 'EXPECTED_ARTIFACTS_MISSING');
  check(Array.isArray(status.artifacts) && status.artifacts.length === 0, 'NO_ARTIFACTS_REQUIRED');
  check(Array.isArray(status.runs) && status.runs.length === 1, 'ONE_ATTEMPT_REQUIRED');
  const run = status.runs[0];
  check(reference(run.id) && reference(run.session_id) && run.status === 'failed' && run.generation === 1
    && run.error_class === 'ARTIFACTS_MISSING', 'EXPECTED_FAILED_RUNNER_ATTEMPT');
  const terminal = deliveries?.terminal;
  check(terminal?.userTaskId === config.taskId && terminal.deliveryId === `terminal:${config.taskId}:g1`
    && terminal.generation === 1, 'TERMINAL_DELIVERY_MISMATCH');
  check(String(terminal.chatId) === String(config.chatId)
    && String(terminal.threadId ?? '') === String(config.threadId ?? ''), 'DELIVERY_DESTINATION_MISMATCH');
  check(terminal.status === 'sent' && terminal.attempts === 1 && terminal.legacyStatus == null
    && Number.isSafeInteger(Number(terminal.providerMessageId)) && Number(terminal.providerMessageId) > 0,
  'ONE_REAL_TERMINAL_SEND_REQUIRED');
  check(Array.isArray(journal), 'ADMISSION_JOURNAL_REQUIRED');
  const admissions = journal.filter(line => line.kind === 'admission' && line.record?.userTaskId === config.taskId);
  check(admissions.length === 1 && admissions[0].record.runId === run.session_id
    && admissions[0].record.ownerGeneration === 1 && admissions[0].record.profileId === config.profile,
  'ONE_MATCHING_ADMISSION_REQUIRED');
  check(admissions[0].record.spec?.outputs?.length === 1
    && admissions[0].record.spec.outputs[0].path === 'outputs/category-results.csv', 'MANDATORY_CSV_OUTPUT_REQUIRED');
  const dispatches = journal.filter(line => line.kind === 'dispatched' && line.runId === run.session_id);
  check(dispatches.length === 1, 'ONE_DISPATCH_REQUIRED');
  return { outcome: 'pass', taskId: config.taskId, generation: 1, runnerRunId: run.session_id,
    attemptId: run.id, failureClass: 'ARTIFACTS_MISSING', artifactCount: 0, attemptCount: 1,
    admissionCount: 1, dispatchCount: 1, terminalAttempts: 1, providerMessageId: String(terminal.providerMessageId),
    ingress: 'authorized_injected_update', delivery: 'bot_api_accepted', humanReading: 'unknown' };
}

export async function operate(mode, config, { fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  check(['--prepare', '--submit-approved', '--observe'].includes(mode), 'MODE_REQUIRED');
  const expected = identity(config);
  if (mode === '--prepare') {
    const handle = await open(config.checkpointFile, 'wx', 0o600);
    try { await save(handle, { version: 1, ...expected, phase: 'prepared' }); } finally { await handle.close(); }
    const directory = await open(dirname(config.checkpointFile), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
    return { outcome: 'prepared', taskId: config.taskId, liveRun: 'not_started' };
  }
  const lockFile = `${config.checkpointFile}.lock`;
  const lock = await open(lockFile, 'wx', 0o600);
  let handle;
  try {
    const checkpoint = JSON.parse(await privateText(config.checkpointFile));
    check(checkpoint.version === 1 && Object.entries(expected).every(([name, value]) => checkpoint[name] === value), 'CHECKPOINT_IDENTITY_MISMATCH');
    handle = await open(config.checkpointFile, constants.O_RDWR | constants.O_NOFOLLOW);
    const deadline = Date.now() + config.timeoutMs;
    const gatewayHeaders = { 'x-telegram-bot-api-secret-token': config.secret, 'content-type': 'application/json' };
    const cpHeaders = { 'x-principal': config.principal, 'x-principal-sig': config.signature, 'content-type': 'application/json' };
    if (config.apiKey) cpHeaders.authorization = `Bearer ${config.apiKey}`;
    async function request(url, method, headers, body) {
      const remaining = deadline - Date.now();
      check(remaining > 0, 'OBSERVATION_DEADLINE');
      let reader;
      try {
        const response = await fetchImpl(url, { method, headers, body, redirect: 'error',
          signal: AbortSignal.timeout(Math.min(config.requestTimeoutMs, remaining)) });
        check(response.ok, `HTTP_${response.status}`);
        reader = response.body.getReader();
        const chunks = [];
        let bytes = 0;
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          bytes += item.value.byteLength;
          check(bytes <= 262144, 'HTTP_BODY_TOO_LARGE');
          chunks.push(Buffer.from(item.value));
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (error) {
        if (error.safeCode) throw error;
        throw Object.assign(new Error('TRANSPORT_TIMEOUT_OR_JSON'), { safeCode: 'TRANSPORT_TIMEOUT_OR_JSON' });
      } finally {
        if (reader) { try { await reader.cancel(); } catch {} reader.releaseLock(); }
      }
    }
    const gateway = path => request(`${config.gatewayUrl}${path}`, 'GET', gatewayHeaders);
    if (mode === '--submit-approved') {
      check(config.approved && checkpoint.phase === 'prepared', 'EXPLICIT_APPROVAL_AND_FRESH_PREPARE_REQUIRED');
      const health = await gateway('/health');
      check(health.status === 'ok' && health.bot === config.username && health.mode === 'direct', 'EXPECTED_SANDBOX_HEALTH');
      const cutover = await gateway('/delivery-cutover');
      check(cutover.ready === true && cutover.paused === false && cutover.cutoverId === config.cutoverId, 'REVIEWED_AUTODELIVERY_REQUIRED');
      checkpoint.phase = 'submission_unknown';
      await save(handle, checkpoint);
      const accepted = await request(`${config.gatewayUrl}/webhook`, 'POST', gatewayHeaders, serializeUpdate(config));
      check(accepted.ok === true && accepted.userTaskId === config.taskId && accepted.duplicate === false, 'FRESH_ACCEPTANCE_MISMATCH');
      checkpoint.phase = 'accepted';
      await save(handle, checkpoint);
      return { outcome: 'accepted', taskId: config.taskId, next: 'read_only_observe' };
    }
    check(['submission_unknown', 'accepted', 'observed', 'passed'].includes(checkpoint.phase), 'SUBMISSION_CHECKPOINT_REQUIRED');
    while (Date.now() < deadline) {
      const status = await request(`${config.controlPlaneUrl}/status`, 'POST', cpHeaders, JSON.stringify({ taskId: config.taskId }));
      check(status.taskStore?.id === config.taskId, 'TASK_ID_MISMATCH');
      if (['done', 'failed', 'cancelled'].includes(status.taskStore.status)) {
        check(status.taskStore.status === 'failed', 'UNEXPECTED_TERMINAL_OUTCOME');
        const deliveries = await gateway(`/deliveries/${config.taskId}`);
        if (deliveries.terminal && ['unknown', 'sending', 'quarantined', 'dead'].includes(deliveries.terminal.status)) {
          check(false, 'DELIVERY_NOT_SAFELY_TERMINAL');
        }
        if (deliveries.terminal?.status === 'sent') {
          check(isAbsolute(config.admissionFile ?? ''), 'PRIVATE_ADMISSION_SNAPSHOT_REQUIRED');
          const journalText = await privateText(config.admissionFile, 8388608);
          const journal = journalText.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
          const proof = verifyNegative(status, deliveries, config, journal);
          if (checkpoint.proof) check(JSON.stringify(checkpoint.proof) === JSON.stringify(proof), 'PRESERVED_PROOF_CHANGED');
          checkpoint.proof = proof;
          checkpoint.phase = 'observed';
          await save(handle, checkpoint);
          await sleep(Math.min(config.pollIntervalMs, Math.max(0, deadline - Date.now())));
          const again = await request(`${config.controlPlaneUrl}/status`, 'POST', cpHeaders, JSON.stringify({ taskId: config.taskId }));
          const confirmed = verifyNegative(again, await gateway(`/deliveries/${config.taskId}`), config, journal);
          check(JSON.stringify(proof) === JSON.stringify(confirmed), 'READBACK_PROOF_CHANGED');
          checkpoint.phase = 'passed';
          await save(handle, checkpoint);
          return proof;
        }
      }
      await sleep(Math.min(config.pollIntervalMs, Math.max(0, deadline - Date.now())));
    }
    check(false, 'OBSERVATION_DEADLINE');
  } finally {
    if (handle) await handle.close();
    await lock.close();
    await unlink(lockFile);
  }
}

async function main() {
  try {
    check(process.argv.length === 3, 'MODE_REQUIRED');
    const config = readNegativeConfig(await loadBindings());
    const result = await operate(process.argv[2], config);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.log(JSON.stringify({ outcome: 'blocked_or_incomplete', safeCode: error.safeCode ?? 'PRIVATE_CONFIG_OR_CHECKPOINT_ERROR',
      retry: 'forbidden; reconcile original checkpoint read-only' }));
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
