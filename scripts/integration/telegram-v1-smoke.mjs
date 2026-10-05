import { randomInt } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { PRODUCTION_BOT_USERNAMES } from '../../src/sandbox-tg/config.js';

class SmokeError extends Error {
  constructor(message, outcome = 'fail') {
    super(message);
    this.outcome = outcome;
  }
}

function requireCondition(condition, message, outcome) {
  if (!condition) throw new SmokeError(message, outcome);
}

function required(bindings, name) {
  const value = String(bindings[name] ?? '').trim();
  requireCondition(value, `Missing ${name}`, 'blocked');
  return value;
}

function integer(bindings, name, fallback, min, max) {
  const value = Number(bindings[name] ?? fallback);
  requireCondition(Number.isSafeInteger(value) && value >= min && value <= max, `Invalid ${name}`, 'blocked');
  return value;
}

function baseUrl(bindings, name) {
  let url;
  try {
    url = new URL(required(bindings, name));
  } catch {
    throw new SmokeError(`Missing or invalid ${name}`, 'blocked');
  }
  requireCondition(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash,
    `${name} must be an HTTPS base URL without credentials, query or fragment`, 'blocked');
  return url.href.replace(/\/+$/, '');
}

export async function loadBindings(environment = process.env) {
  let fileBindings = {};
  if (environment.INTEGRATION_BINDINGS_FILE) {
    try {
      const metadata = await stat(environment.INTEGRATION_BINDINGS_FILE);
      requireCondition(metadata.isFile() && (metadata.mode & 0o077) === 0,
        'INTEGRATION_BINDINGS_FILE must be private (chmod 600)', 'blocked');
      fileBindings = JSON.parse(await readFile(environment.INTEGRATION_BINDINGS_FILE, 'utf8'));
      requireCondition(fileBindings && typeof fileBindings === 'object' && !Array.isArray(fileBindings),
        'INTEGRATION_BINDINGS_FILE must contain a JSON object', 'blocked');
    } catch (error) {
      if (error instanceof SmokeError) throw error;
      throw new SmokeError('Cannot read private INTEGRATION_BINDINGS_FILE JSON', 'blocked');
    }
  }
  const bindings = { ...fileBindings, ...environment };
  let savedUpdateBody;
  if (bindings.INTEGRATION_UPDATE_FILE) {
    try {
      const metadata = await stat(bindings.INTEGRATION_UPDATE_FILE);
      requireCondition(metadata.isFile() && (metadata.mode & 0o077) === 0 && metadata.size <= 65536,
        'INTEGRATION_UPDATE_FILE must be private and at most 65536 bytes', 'blocked');
      savedUpdateBody = await readFile(bindings.INTEGRATION_UPDATE_FILE, 'utf8');
      JSON.parse(savedUpdateBody);
    } catch (error) {
      if (error instanceof SmokeError) throw error;
      throw new SmokeError('Cannot read private INTEGRATION_UPDATE_FILE JSON', 'blocked');
    }
  }
  return { ...bindings, savedUpdateBody };
}

export function readConfig(bindings) {
  const chatId = integer(bindings, 'TEST_CHAT_ID', undefined, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  requireCondition(chatId !== 0, 'Invalid TEST_CHAT_ID', 'blocked');
  const allowedChats = required(bindings, 'TG_SLICE_ALLOWED_CHATS').split(',').map(value => value.trim());
  requireCondition(allowedChats.includes(String(chatId)), 'TEST_CHAT_ID is not in TG_SLICE_ALLOWED_CHATS', 'blocked');
  const signature = required(bindings, 'CONTROL_PLANE_PRINCIPAL_SIGNATURE');
  requireCondition(/^[a-fA-F0-9]{64}$/.test(signature), 'Invalid CONTROL_PLANE_PRINCIPAL_SIGNATURE', 'blocked');
  const secret = required(bindings, 'TELEGRAM_WEBHOOK_SECRET');
  requireCondition(/^[A-Za-z0-9_-]{1,256}$/.test(secret), 'Invalid TELEGRAM_WEBHOOK_SECRET', 'blocked');
  const username = required(bindings, 'TG_SANDBOX_BOT_USERNAME').replace(/^@/, '');
  requireCondition(/^[A-Za-z0-9_]+$/.test(username) && !PRODUCTION_BOT_USERNAMES.includes(username.toLowerCase()),
    'TG_SANDBOX_BOT_USERNAME must be a separate sandbox bot', 'blocked');
  const threadId = bindings.TEST_THREAD_ID == null ? null : integer(bindings, 'TEST_THREAD_ID', undefined, 1, 2147483647);
  const chatType = String(bindings.TEST_CHAT_TYPE ?? (chatId > 0 ? 'private' : 'supergroup'));
  requireCondition(['private', 'group', 'supergroup'].includes(chatType), 'Invalid TEST_CHAT_TYPE', 'blocked');
  requireCondition(threadId === null || chatType === 'supergroup', 'TEST_THREAD_ID requires a supergroup', 'blocked');
  const text = String(bindings.SMOKE_TEXT ?? 'Каково состояние системы?');
  requireCondition(text.trim().length > 0 && text.length <= 4096, 'Invalid SMOKE_TEXT', 'blocked');
  const reconciliationMode = String(bindings.SMOKE_RECONCILIATION_MODE ?? 'manual');
  requireCondition(['manual', 'autonomous'].includes(reconciliationMode), 'Invalid SMOKE_RECONCILIATION_MODE', 'blocked');
  if (reconciliationMode === 'autonomous') {
    required(bindings, 'SMOKE_UPDATE_ID');
    required(bindings, 'SMOKE_MESSAGE_ID');
    required(bindings, 'SMOKE_MESSAGE_DATE');
    required(bindings, 'INTEGRATION_UPDATE_FILE');
    requireCondition(typeof bindings.savedUpdateBody === 'string' && bindings.savedUpdateBody.length > 0,
      'Autonomous mode requires a prepared private saved update', 'blocked');
  }
  return {
    gatewayUrl: baseUrl(bindings, 'GATEWAY_URL'),
    controlPlaneUrl: baseUrl(bindings, 'CONTROL_PLANE_URL'),
    principal: required(bindings, 'CONTROL_PLANE_PRINCIPAL'),
    profile: required(bindings, 'CONTROL_PLANE_PROFILE'),
    signature,
    secret,
    username,
    botToken: String(bindings.TG_SANDBOX_BOT_TOKEN ?? '').trim(),
    apiKey: String(bindings.CONTROL_PLANE_API_KEY ?? '').trim(),
    chatId,
    chatType,
    threadId,
    userId: integer(bindings, 'TEST_USER_ID', undefined, 1, Number.MAX_SAFE_INTEGER),
    updateId: integer(bindings, 'SMOKE_UPDATE_ID', randomInt(1, 2147483647), 1, 2147483647),
    messageId: integer(bindings, 'SMOKE_MESSAGE_ID', randomInt(1, 2147483647), 1, 2147483647),
    messageDate: bindings.SMOKE_MESSAGE_DATE == null ? null : integer(bindings, 'SMOKE_MESSAGE_DATE', undefined, 1, 2147483647),
    savedUpdateBody: bindings.savedUpdateBody,
    reconciliationMode,
    text,
    timeoutMs: integer(bindings, 'SMOKE_TIMEOUT_MS', 120000, 1000, 900000),
    requestTimeoutMs: integer(bindings, 'SMOKE_REQUEST_TIMEOUT_MS', 60000, 100, 60000),
    pollIntervalMs: integer(bindings, 'SMOKE_POLL_INTERVAL_MS', 2000, 100, 30000),
  };
}

function identifier(value, label) {
  requireCondition(typeof value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(value), `Invalid ${label}`);
  return value;
}

export function readLiveConfig(bindings) {
  required(bindings, 'SMOKE_UPDATE_ID');
  required(bindings, 'SMOKE_MESSAGE_ID');
  required(bindings, 'SMOKE_MESSAGE_DATE');
  const config = readConfig(bindings);
  serializeUpdate(config);
  return config;
}

export function serializeUpdate(config, fallbackDate = Math.floor(Date.now() / 1000)) {
  const update = {
    update_id: config.updateId,
    message: {
      message_id: config.messageId, date: config.messageDate ?? fallbackDate,
      from: { id: config.userId, is_bot: false, first_name: 'Integration smoke' },
      chat: { id: config.chatId, type: config.chatType },
      ...(config.threadId === null ? {} : { message_thread_id: config.threadId, is_topic_message: true }),
      text: config.text,
    },
  };
  if (config.savedUpdateBody !== undefined) {
    let saved;
    try {
      saved = JSON.parse(config.savedUpdateBody);
    } catch {
      throw new SmokeError('Saved update must contain JSON', 'blocked');
    }
    requireCondition(isDeepStrictEqual(saved, update), 'Saved update does not match pinned smoke bindings', 'blocked');
    return config.savedUpdateBody;
  }
  return JSON.stringify(update);
}

function deliveryRecords(payload, config, taskId) {
  const records = Array.isArray(payload?.deliveries) ? payload.deliveries :
    payload && Object.hasOwn(payload, 'receipt') && Object.hasOwn(payload, 'terminal') ?
      [payload.receipt, payload.terminal].filter(record => record != null) : null;
  requireCondition(Array.isArray(records), 'Delivery response must contain receipt/terminal summaries or deliveries[]');
  const seen = new Set();
  return records.map(record => {
    requireCondition(record && record.userTaskId === taskId, 'Delivery task mismatch');
    const deliveryId = identifier(record.deliveryId, 'deliveryId');
    requireCondition(!seen.has(deliveryId), 'Duplicate deliveryId in evidence');
    seen.add(deliveryId);
    requireCondition(String(record.chatId) === String(config.chatId) &&
      String(record.threadId ?? '') === String(config.threadId ?? ''), 'Delivery destination mismatch');
    requireCondition(['pending', 'retrying', 'sent', 'dead'].includes(record.status), 'Invalid delivery status');
    requireCondition(Number.isSafeInteger(record.attempts) && record.attempts >= 0, 'Invalid delivery attempts');
    if (record.status === 'sent') {
      requireCondition(Number.isSafeInteger(Number(record.providerMessageId)) && Number(record.providerMessageId) > 0 &&
        record.attempts > 0, 'Sent delivery lacks Bot API providerMessageId or attempt');
    }
    return {
      deliveryId,
      userTaskId: taskId,
      status: record.status,
      attempts: record.attempts,
      providerMessageId: record.providerMessageId == null ? null : String(record.providerMessageId),
    };
  }).sort((first, second) => first.deliveryId.localeCompare(second.deliveryId));
}

function taskSnapshot(payload, config, taskId) {
  const row = payload?.taskStore;
  requireCondition(row?.id === taskId, 'CP status task mismatch');
  if (row.profile_id != null) requireCondition(row.profile_id === config.profile, 'CP status profile mismatch');
  requireCondition(typeof row.status === 'string' && Number.isSafeInteger(row.generation), 'Invalid CP task state');
  requireCondition(Array.isArray(payload.runs), 'CP status must contain runs[]');
  const orchestrationAttemptIds = payload.runs.map(run => identifier(run.id, 'orchestrationAttemptId')).sort();
  const runIds = payload.runs.filter(run => run.session_id != null)
    .map(run => identifier(run.session_id, 'Runner runId')).sort();
  const answer = typeof row.result === 'string' ? row.result : row.result?.answer;
  return { status: row.status, generation: row.generation, runIds, orchestrationAttemptIds,
    hasAnswer: typeof answer === 'string' && !!answer.trim() };
}

export async function runSmoke(config, { fetchImpl = fetch, emit = value => console.log(JSON.stringify(value)) } = {}) {
  const startedAt = Date.now();
  const deadline = startedAt + config.timeoutMs;
  const gatewayHeaders = { 'x-telegram-bot-api-secret-token': config.secret, 'content-type': 'application/json' };
  const cpHeaders = { 'x-principal': config.principal, 'x-principal-sig': config.signature, 'content-type': 'application/json' };
  if (config.apiKey) cpHeaders.authorization = `Bearer ${config.apiKey}`;
  const evidence = {
    outcome: 'running', ingress: 'authorized_injected_update', updateId: config.updateId, messageId: config.messageId,
    duplicate: false, receipt: 'unverified', result: 'unverified', delivery: 'unverified', humanReading: 'unknown',
  };
  const reconciliationMode = config.reconciliationMode ?? 'manual';
  evidence.reconciliationMode = reconciliationMode;
  const secrets = [config.secret, config.signature, config.botToken, config.apiKey].filter(Boolean);
  const output = value => {
    const serialized = JSON.stringify(value);
    requireCondition(!secrets.some(secret => serialized.includes(secret)), 'Evidence redaction refused unsafe output');
    emit(value);
  };
  async function request(label, url, method, headers, body) {
    const remaining = deadline - Date.now();
    requireCondition(remaining > 0, 'Smoke deadline exceeded');
    let response;
    try {
      response = await fetchImpl(url, {
        method, headers, body, redirect: 'error', signal: AbortSignal.timeout(Math.min(config.requestTimeoutMs, remaining)),
      });
      requireCondition(response.ok, `${label} HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (error instanceof SmokeError) throw error;
      throw new SmokeError(`${label} transport, timeout or JSON failure`);
    }
  }
  const gateway = (path, method = 'GET', body) => request('Gateway', `${config.gatewayUrl}${path}`, method, gatewayHeaders, body);
  const status = taskId => request('CP status', `${config.controlPlaneUrl}/status`, 'POST', cpHeaders, JSON.stringify({ taskId }));
  try {
    requireCondition(['manual', 'autonomous'].includes(reconciliationMode), 'Invalid SMOKE_RECONCILIATION_MODE', 'blocked');
    if (reconciliationMode === 'autonomous') {
      requireCondition(typeof config.savedUpdateBody === 'string' && config.savedUpdateBody.length > 0
        && Number.isSafeInteger(config.messageDate) && config.messageDate > 0,
      'Autonomous mode requires a prepared private saved update and pinned date', 'blocked');
    }
    const updateBody = serializeUpdate(config, Math.floor(startedAt / 1000));
    const health = await request('Gateway health', `${config.gatewayUrl}/health`, 'GET', {}, undefined);
    requireCondition(health.status === 'ok' && health.bot === config.username && health.mode === 'direct',
      'Gateway health must identify the configured direct-mode sandbox');
    if (config.botToken && reconciliationMode === 'manual') {
      const identity = await request('Telegram getMe', `https://api.telegram.org/bot${config.botToken}/getMe`, 'GET', {}, undefined);
      requireCondition(identity.ok === true && identity.result?.is_bot === true && identity.result.username === config.username,
        'Telegram getMe sandbox identity mismatch');
      evidence.botIdentity = 'getMe_verified';
    } else evidence.botIdentity = 'gateway_health_only';
    const accepted = await gateway('/webhook', 'POST', updateBody);
    requireCondition(accepted.ok === true, 'Gateway refused ingress');
    const taskId = identifier(accepted.userTaskId, 'userTaskId');
    evidence.userTaskId = taskId;
    const duplicate = await gateway('/webhook', 'POST', updateBody);
    requireCondition(duplicate.ok === true && duplicate.duplicate === true && duplicate.userTaskId === taskId,
      'Identical update did not return duplicate=true and the same userTaskId');
    evidence.duplicate = true;
    output({ ...evidence, event: 'ingress_verified', elapsedMs: Date.now() - startedAt });
    let previousProgress;
    while (Date.now() < deadline) {
      const snapshot = taskSnapshot(await status(taskId), config, taskId);
      evidence.taskStatus = snapshot.status;
      evidence.generation = snapshot.generation;
      evidence.runIds = snapshot.runIds;
      evidence.orchestrationAttemptIds = snapshot.orchestrationAttemptIds;
      evidence.result = snapshot.status === 'done' && snapshot.hasAnswer ? 'ready' : 'unverified';
      if (reconciliationMode === 'manual') await gateway('/cron');
      const records = deliveryRecords(await gateway(`/deliveries/${encodeURIComponent(taskId)}`), config, taskId);
      const receipts = records.filter(record => record.deliveryId.startsWith('receipt:') || record.deliveryId === taskId);
      const terminal = records.find(record => record.deliveryId === `terminal:${taskId}:g${snapshot.generation}`);
      evidence.receipt = receipts.some(record => record.status === 'sent') ? 'sent' : 'unverified';
      evidence.delivery = terminal?.status ?? 'unverified';
      requireCondition(!['failed', 'cancelled'].includes(snapshot.status), 'Task ended without a successful result');
      requireCondition(terminal?.status !== 'dead', 'Terminal delivery exhausted retries');
      if (snapshot.status === 'done') requireCondition(snapshot.hasAnswer, 'CP done has no final answer');
      if (evidence.result === 'ready' && terminal?.status === 'sent') {
        if (reconciliationMode === 'manual') await gateway('/cron');
        const replay = deliveryRecords(await gateway(`/deliveries/${encodeURIComponent(taskId)}`), config, taskId);
        requireCondition(JSON.stringify(replay) === JSON.stringify(records), 'Reconciliation replay changed delivery evidence');
        const final = taskSnapshot(await status(taskId), config, taskId);
        requireCondition(JSON.stringify(final) === JSON.stringify(snapshot), 'Reconciliation replay changed task or runs');
        evidence.outcome = 'pass';
        evidence.delivery = 'bot_api_accepted';
        evidence.providerMessageId = terminal.providerMessageId;
        evidence.receipts = receipts;
        evidence.terminal = terminal;
        evidence.reconciliationReplay = reconciliationMode === 'manual' ? 'unchanged' : 'not_invoked';
        evidence.deliveryReadback = 'unchanged';
        evidence.elapsedMs = Date.now() - startedAt;
        output(evidence);
        return evidence;
      }
      const progress = JSON.stringify([snapshot.status, evidence.receipt, evidence.delivery]);
      if (progress !== previousProgress) {
        output({ ...evidence, event: 'poll', elapsedMs: Date.now() - startedAt });
        previousProgress = progress;
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(config.pollIntervalMs, Math.max(0, deadline - Date.now()))));
    }
    throw new SmokeError('Smoke deadline exceeded before result and Bot API acceptance');
  } catch (error) {
    evidence.outcome = error instanceof SmokeError ? error.outcome : 'fail';
    evidence.reason = error instanceof SmokeError ? error.message : 'Unexpected smoke failure';
    evidence.elapsedMs = Date.now() - startedAt;
    output(evidence);
    return evidence;
  }
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('Usage: node scripts/integration/telegram-v1-smoke.mjs [--help]\nBindings: environment and optional private INTEGRATION_BINDINGS_FILE. See docs/INTEGRATION-V1-SMOKE.md.');
    return;
  }
  try {
    requireCondition(process.argv.length === 2, 'Unknown command-line arguments', 'blocked');
    const config = readLiveConfig(await loadBindings());
    const evidence = await runSmoke(config);
    process.exitCode = evidence.outcome === 'pass' ? 0 : evidence.outcome === 'blocked' ? 2 : 1;
  } catch (error) {
    console.log(JSON.stringify({ outcome: error instanceof SmokeError ? error.outcome : 'fail',
      reason: error instanceof SmokeError ? error.message : 'Unexpected preflight failure', liveRun: 'not_started' }));
    process.exitCode = error instanceof SmokeError && error.outcome === 'blocked' ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
