#!/usr/bin/env node
// Two-move production canary on the REAL production bot path (BACKLOG B1 /
// milestone PROD exit criterion 2): message -> «▶️ Запустить» -> task done ->
// answer delivered into chat 1714048, twice, with the second answer proving
// the first turn's context survived the round trip through CP -> Runner ->
// France VM -> gateway delivery.
//
// This check injects synthetic Telegram updates straight into the production
// worker webhook
// (continuous-dev/TESTING.md §2). The lane is pinned by machine-checkable
// bot identity: a run that ever targets another bot fails loudly (E6 lesson).
//
// Oracle (R12): PASS/FAIL is decided by deterministic checks over worker
// debug state + Telegram provider evidence — never by free-text judgement.
// The only human judgement left (operator eye-check of the delivered
// messages in the chat) is explicitly out of scope here.
//
// Secrets via env only (R9), never argv/logs: WEBHOOK_SECRET, AGENT_SECRET,
// BOT_TOKEN. Optional: WORKER_URL, CHAT_ID, EVIDENCE_OUT.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { verifyCompleteAnswer } from './complete-answer-oracle.mjs';
import { controlPlaneBarrierCounts, terminalDeliveriesSince } from './e2e-oracle.mjs';

const WORKER = process.env.WORKER_URL ?? 'https://trained-assist-tg-bot.skillset-apply.workers.dev';
const CHAT_ID = Number(process.env.CHAT_ID ?? 1714048);
const LANE = 'production';
const ARCHITECTURE = process.env.E2E_SCENARIO === 'architecture';
const EMPTY_ANSWER_RETRY = process.env.E2E_SCENARIO === 'empty-answer-retry';
const VOICE_INGRESS = process.env.E2E_SCENARIO === 'voice-ingress';
const EXPECTED_BOT_USERNAME = 'super_personal_assistant_bot';
const EXPECTED_BUILD_SHA = process.env.EXPECTED_BUILD_SHA ?? '';
const EVIDENCE_PATH = process.env.EVIDENCE_OUT ?? 'prod-two-move-canary-evidence.json';
const POLL_MS = 5_000;
const COLLECTOR_TIMEOUT_MS = 120_000;
// Voice intake can spend three minutes in the production quiet gate before the
// Runner and the terminal delivery begin; keep the E2E deadline beyond both.
const DELIVERY_TIMEOUT_MS = VOICE_INGRESS ? 600_000 : 300_000;

const secrets = {
  webhook: process.env.WEBHOOK_SECRET,
  agent: process.env.AGENT_SECRET,
  bot: process.env.BOT_TOKEN,
};
for (const [name, value] of Object.entries(secrets)) {
  assert.ok(value, `missing_secret_env:${name}`);
}

let evidence = {
  ok: false,
  scenario: 'prod-two-move-canary-context-and-delivery',
  lane: LANE,
  botUsername: null,
  targetWorkerUrl: WORKER,
  chatId: CHAT_ID,
  buildSha: null,
  phase: 'starting',
  moves: [],
  failures: [],
};

async function checkpoint(phase, patch = {}) {
  evidence = { ...evidence, ...patch, phase };
  await writeFile(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
}

function fail(phase, error) {
  const message = error?.message ?? String(error);
  evidence.failures.push({ phase, error: message });
  return { phase, error: message };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function isTransientNetworkError(error) {
  const text = `${error?.message ?? ''} ${error?.cause?.message ?? ''} ${error?.cause?.code ?? ''}`;
  return /fetch failed|network|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR/i.test(text);
}

async function withRetry(fn, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isTransientNetworkError(error) || attempt === attempts - 1) throw error;
      await sleep(1500 * (attempt + 1));
    }
  }
  throw lastError;
}

async function workerGet(path, token, header = 'Authorization') {
  const res = await withRetry(() => fetch(`${WORKER}${path}`, { headers: { [header]: `Bearer ${token}` } }));
  if (!res.ok) throw new Error(`worker_${path.replace(/\W+/g, '_')}_${res.status}`);
  return res.json();
}

async function tg(method, payload) {
  const res = await withRetry(() => fetch(`https://api.telegram.org/bot${secrets.bot}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }));
  const body = await res.json();
  if (!body.ok) throw new Error(`telegram_${method}_${body.error_code ?? res.status}:${body.description ?? 'unknown'}`);
  return body.result;
}

let updateSeq = Date.now();
function nextUpdateId() {
  updateSeq += 1;
  return updateSeq;
}

async function injectTextMessage(text) {
  const updateId = nextUpdateId();
  const res = await withRetry(() => fetch(`${WORKER}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secrets.webhook },
    body: JSON.stringify({
      update_id: updateId,
      message: {
        message_id: updateId,
        from: { id: CHAT_ID, is_bot: false, first_name: 'T', username: 'kobzevvv' },
        chat: { id: CHAT_ID, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text,
      },
    }),
  }));
  const body = await res.json().catch(() => ({}));
  assert.ok(res.ok && body.ok === true, `webhook_inject_rejected_${res.status}`);
  return updateId;
}

async function injectVoiceMessage() {
  const bytes = await readFile(new URL('../tests/fixtures/production-voice-canary.ogg', import.meta.url));
  assert.ok(bytes.length > 0 && bytes.length < 1024 * 1024, 'synthetic_voice_fixture_invalid');
  const form = new FormData();
  form.set('chat_id', String(CHAT_ID));
  form.set('voice', new Blob([bytes], { type: 'audio/ogg' }), 'production-voice-canary.ogg');
  const sent = await withRetry(async () => {
    const response = await fetch(`https://api.telegram.org/bot${secrets.bot}/sendVoice`, { method: 'POST', body: form });
    const body = await response.json();
    if (!response.ok || body.ok !== true) throw new Error(`telegram_sendVoice_${body.error_code ?? response.status}`);
    return body.result;
  });
  assert.ok(sent.voice?.file_id && sent.voice?.file_unique_id, 'telegram_voice_file_id_missing');
  const updateId = nextUpdateId();
  const response = await withRetry(() => fetch(`${WORKER}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secrets.webhook },
    body: JSON.stringify({ update_id: updateId, message: {
      message_id: updateId,
      from: { id: CHAT_ID, is_bot: false, first_name: 'T', username: 'kobzevvv' },
      chat: { id: CHAT_ID, type: 'private' },
      date: Math.floor(Date.now() / 1000),
      voice: { file_id: sent.voice.file_id, file_unique_id: sent.voice.file_unique_id,
        duration: sent.voice.duration, mime_type: sent.voice.mime_type ?? 'audio/ogg',
        file_size: sent.voice.file_size ?? bytes.length },
    } }),
  }));
  const body = await response.json().catch(() => ({}));
  assert.ok(response.ok && body.ok === true, `voice_webhook_inject_rejected_${response.status}`);
  return { updateId, sourceMessageId: sent.message_id, bytes: bytes.length };
}

async function tapCollector(collectorMsgId, draftRevision) {
  const callbackId = `cb-b1-${randomBytes(4).toString('hex')}`;
  const res = await withRetry(() => fetch(`${WORKER}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secrets.webhook },
    body: JSON.stringify({
      update_id: nextUpdateId(),
      callback_query: {
        id: callbackId,
        from: { id: CHAT_ID, is_bot: false, username: 'kobzevvv' },
        message: { message_id: collectorMsgId, chat: { id: CHAT_ID, type: 'private' } },
        data: `ws|auto|${draftRevision}`,
      },
    }),
  }));
  const body = await res.json().catch(() => ({}));
  assert.ok(res.ok && body.ok === true, `collector_tap_rejected_${res.status}`);
}

async function waitForCollector() {
  const deadline = Date.now() + COLLECTOR_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    last = await workerGet(`/debug/intake/${CHAT_ID}`, secrets.agent);
    if (last.collectorMsgId && Number.isSafeInteger(last.collectorDraftRevision)) {
      if (last.collectorDelivery?.state === 'sent') return last;
    }
    await sleep(POLL_MS);
  }
  throw new Error(`collector_not_ready:${JSON.stringify(summarizeIntake(last))}`);
}

async function waitForTerminalDelivery(since) {
  const deadline = Date.now() + DELIVERY_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    const { deliveries } = await workerGet(`/debug/deliveries?chatId=${CHAT_ID}`, secrets.agent);
    last = deliveries ?? [];
    const fresh = terminalDeliveriesSince(last, since);
    const sent = fresh.find(d => d.status === 'sent' && Number.isSafeInteger(d.providerMessageId));
    if (sent) return { delivery: sent, deliveries: last };
    const terminalFailure = fresh.find(d => ['failed', 'dead', 'gave_up'].includes(d.status));
    if (terminalFailure) throw new Error(`delivery_failed:${terminalFailure.deliveryId}:${terminalFailure.reason}`);
    await sleep(POLL_MS);
  }
  throw new Error(`delivery_timeout_after_${DELIVERY_TIMEOUT_MS}ms:${JSON.stringify(last?.slice(0, 3) ?? [])}`);
}

async function waitForCleanIntake() {
  const deadline = Date.now() + 180_000;
  let intake;
  while (Date.now() < deadline) {
    intake = await workerGet(`/debug/intake/${CHAT_ID}`, secrets.agent);
    const barrier = controlPlaneBarrierCounts(intake);
    if (intake.busy === false && intake.stranded === false &&
        (intake.buf ?? []).length === 0 && (intake.retryBatch ?? []).length === 0 &&
        barrier.busyRequestCount === 0 && barrier.unresolvedLaunchCount === 0) return intake;
    await sleep(POLL_MS);
  }
  throw new Error(`intake_cleanup_timeout:${JSON.stringify(summarizeIntake(intake))}`);
}

function summarizeIntake(intake) {
  return {
    busy: intake?.busy === true,
    bufCount: Array.isArray(intake?.buf) ? intake.buf.length : null,
    collectorMsgId: intake?.collectorMsgId ?? null,
    stranded: intake?.stranded === true,
    ...controlPlaneBarrierCounts(intake),
  };
}

async function readDeliveredText(providerMessageId) {
  const forwarded = await tg('forwardMessage', { chat_id: CHAT_ID, from_chat_id: CHAT_ID, message_id: providerMessageId });
  try {
    return typeof forwarded.text === 'string' ? forwarded.text : '';
  } finally {
    await tg('deleteMessage', { chat_id: CHAT_ID, message_id: forwarded.message_id }).catch(() => {});
  }
}

async function runMove({ label, askText, nonce, voice = false }) {
  const startedAt = Date.now();
  const voiceSource = voice ? await injectVoiceMessage() : null;
  if (!voice) await injectTextMessage(askText);
  const collector = await waitForCollector();
  await tapCollector(collector.collectorMsgId, collector.collectorDraftRevision);
  const { delivery } = await waitForTerminalDelivery(startedAt);
  if (ARCHITECTURE) await checkpoint('architecture_delivery_observed', { deliveryId: delivery.deliveryId, userTaskId: delivery.userTaskId });
  const ids = ARCHITECTURE ? delivery.providerMessageIds : [delivery.providerMessageId];
  if (ARCHITECTURE) {
    assert.ok(delivery.partCount > 1 && delivery.sentParts === delivery.partCount, 'all_parts_not_confirmed');
    assert.equal(ids?.length, delivery.partCount, 'provider_receipts_missing');
    assert.equal(new Set(ids).size, ids.length, 'duplicate_provider_receipt');
  }
  const parts = [];
  for (const id of ids) parts.push(await readDeliveredText(id));
  const answerText = ARCHITECTURE ? verifyCompleteAnswer(delivery, parts) : parts.join('');
  // The delivery owner may send the answer before the intake alarm observes
  // the terminal task. A second move must start only after that hold clears.
  await waitForCleanIntake();
  const move = {
    label,
    nonce,
    collectorMsgId: collector.collectorMsgId,
    draftRevision: collector.collectorDraftRevision,
    deliveryId: delivery.deliveryId,
    userTaskId: delivery.userTaskId,
    status: delivery.status,
    reason: delivery.reason,
    providerMessageId: delivery.providerMessageId,
    answerLength: answerText.length,
    answerContainsNonce: nonce ? answerText.includes(nonce) : null,
    answerSha256: null,
    ...(ARCHITECTURE ? { providerCharacters: parts.join('').length, restoredBoundaryWhitespace: answerText.length - parts.join('').length, parts: ids.length, providerMessageIds: ids, sourceDigestMatches: true } : {}),
    elapsedMs: Date.now() - startedAt,
  };
  if (answerText) {
    const { createHash } = await import('node:crypto');
    move.answerSha256 = createHash('sha256').update(answerText).digest('hex');
  }
  evidence.moves.push(move);
  return { move, answerText, voiceSource };
}

async function preflight() {
  const whoami = await workerGet('/debug/whoami', secrets.agent);
  assert.equal(whoami?.bot?.username, EXPECTED_BOT_USERNAME, 'bot_identity_mismatch');
  evidence.botUsername = whoami.bot.username;

  const health = await workerGet('/health', secrets.agent);
  assert.equal(health.executionBackend, 'control-plane', 'execution_backend_not_control_plane');
  assert.equal(health.controlPlaneUrlConfigured, true, 'control_plane_url_not_configured');
  assert.equal(health.ingressPaused, false, 'ingress_paused');
  assert.equal(health.deliveryPaused, false, 'delivery_paused');
  evidence.buildSha = health.buildSha ?? null;
  if (EXPECTED_BUILD_SHA) assert.equal(health.buildSha, EXPECTED_BUILD_SHA, 'production_build_sha_mismatch');

  const intake = await workerGet(`/debug/intake/${CHAT_ID}`, secrets.agent);
  assert.equal(intake.busy, false, 'intake_busy_at_preflight');
  assert.equal(intake.stranded, false, 'intake_stranded_at_preflight');
  assert.deepEqual(intake.buf ?? [], [], 'intake_buf_not_empty_at_preflight');
  assert.deepEqual(intake.retryBatch ?? [], [], 'intake_retry_batch_not_empty_at_preflight');
  assert.deepEqual(controlPlaneBarrierCounts(intake), { busyRequestCount: 0, unresolvedLaunchCount: 0 }, 'barrier_not_clean_at_preflight');
  return { intakeSummary: summarizeIntake(intake) };
}

async function main() {
  const baseline = await preflight();
  await checkpoint('preflight_passed', { baseline: baseline.intakeSummary });

  if (VOICE_INGRESS) {
    assert.equal(WORKER, 'https://trained-assist-tg-bot.skillset-apply.workers.dev', 'fixed_worker_required');
    assert.equal(CHAT_ID, 1714048, 'fixed_test_account_required');
    await checkpoint('voice_ingress_starting', { scenario: 'voice-ingress' });
    const result = await runMove({ label: 'synthetic-voice', voice: true, nonce: null });
    assert.equal(result.move.status, 'sent', 'voice_answer_not_sent');
    assert.equal(result.move.reason, 'provider_accepted', 'voice_answer_not_provider_accepted');
    assert.ok(result.answerText.trim().length > 0, 'voice_answer_empty');
    const finalIntake = await waitForCleanIntake();
    assert.equal(finalIntake.busy, false, 'voice_intake_busy_at_final');
    assert.equal(finalIntake.stranded, false, 'voice_intake_stranded_at_final');
    assert.deepEqual(controlPlaneBarrierCounts(finalIntake), { busyRequestCount: 0, unresolvedLaunchCount: 0 }, 'voice_barrier_not_clean_at_final');
    await checkpoint('passed', { ok: true, scenario: 'voice-ingress', voiceBytes: result.voiceSource.bytes,
      voiceSourceMessageId: result.voiceSource.sourceMessageId, finalIntake: summarizeIntake(finalIntake),
      deliveredAnswerCharacters: result.answerText.length, deliveredAnswerSha256: result.move.answerSha256 });
    console.log(`PASS voice-ingress task=${result.move.userTaskId} bytes=${result.voiceSource.bytes} answerDigest=${result.move.answerSha256}`);
    return;
  }

  if (EMPTY_ANSWER_RETRY) {
    assert.equal(WORKER, 'https://trained-assist-tg-bot.skillset-apply.workers.dev', 'fixed_worker_required');
    assert.equal(CHAT_ID, 1714048, 'fixed_test_account_required');
    await checkpoint('empty_answer_retry_starting', { scenario: 'empty-answer-retry' });
    const result = await runMove({ label: 'retry-empty-answer', nonce: null,
      askText: 'Гитхаб токен подключен? Second try, last time you completed without outcome. Please answer clearly. This is read-only; do not change credentials.' });
    assert.equal(result.move.status, 'sent', 'retry_answer_not_sent');
    assert.equal(result.move.reason, 'provider_accepted', 'retry_answer_not_provider_accepted');
    assert.ok(result.answerText.trim().length > 0, 'retry_answer_empty');
    assert.doesNotMatch(result.answerText, /^(?:Готово\.?\s*)?Текст результата отсутствует\.?$/i, 'retry_returned_empty_result_placeholder');
    const finalIntake = await workerGet(`/debug/intake/${CHAT_ID}`, secrets.agent);
    assert.equal(finalIntake.busy, false, 'intake_busy_at_final');
    assert.deepEqual(controlPlaneBarrierCounts(finalIntake), { busyRequestCount: 0, unresolvedLaunchCount: 0 }, 'barrier_not_clean_at_final');
    assert.equal(finalIntake.stranded, false, 'intake_stranded_at_final');
    await checkpoint('passed', { ok: true, scenario: 'empty-answer-retry',
      finalIntake: summarizeIntake(finalIntake), deliveredAnswerCharacters: result.answerText.length,
      deliveredAnswerSha256: result.move.answerSha256 });
    console.log(`PASS empty-answer-retry chars=${result.answerText.length} digest=${result.move.answerSha256}`);
    return;
  }

  if (ARCHITECTURE) {
    assert.equal(WORKER, 'https://trained-assist-tg-bot.skillset-apply.workers.dev', 'fixed_worker_required');
    assert.equal(CHAT_ID, 1714048, 'fixed_test_account_required');
    if (process.env.VERIFY_DELIVERY_ID) {
      const id = process.env.VERIFY_DELIVERY_ID;
      const nonce = process.env.EXPECTED_END_MARKER;
      assert.match(id, /^terminal:ut-[a-f0-9]+:g[1-9]\d*$/);
      assert.match(nonce ?? '', /^ARCH-[0-9a-f]{10}$/);
      const { deliveries } = await workerGet(`/debug/deliveries?chatId=${CHAT_ID}&limit=100`, secrets.agent);
      const delivery = deliveries?.find(item => item.deliveryId === id);
      assert.ok(delivery, 'existing_delivery_missing');
      await checkpoint('verifying_existing_delivery', { deliveryId: id, userTaskId: delivery.userTaskId });
      const parts = [];
      for (const providerId of delivery.providerMessageIds ?? []) parts.push(await readDeliveredText(providerId));
      const answer = verifyCompleteAnswer(delivery, parts);
      assert.ok(answer.includes(nonce), 'architecture_end_marker_missing');
      const { createHash } = await import('node:crypto');
      await checkpoint('passed', { ok: true, scenario: 'production-complete-architecture-document',
        verifiedExistingDelivery: true, userTaskId: delivery.userTaskId, parts: parts.length,
        providerMessageIds: delivery.providerMessageIds, sourceCharacters: answer.length,
        providerCharacters: parts.join('').length, restoredBoundaryWhitespace: answer.length - parts.join('').length,
        sourceSha256: createHash('sha256').update(answer).digest('hex'), endMarkerPresent: true });
      console.log(`PASS existing architecture parts=${parts.length} chars=${answer.length}`);
      return;
    }
    const nonce = `ARCH-${randomBytes(5).toString('hex')}`;
    await checkpoint('architecture_task_starting', { scenario: 'production-complete-architecture-document' });
    const result = await runMove({ label: 'complete-architecture', nonce,
      askText: `Спроектируй MVP сервиса обработки PDF для 100 команд и 5000 документов в день. Нужны загрузка, асинхронное извлечение текста, резюме, поиск, изоляция команд, удаление, повторные попытки без дубликатов и лимиты затрат. Дай конкретные компоненты, схему данных, API, жизненный цикл задания, отказы и этапы MVP. Ответ на русском: 400–500 слов, 7 содержательных абзацев, отделённых пустой строкой. Это только проектный документ: без инструментов, поиска, файлов и развёртывания. В конце напиши метку ${nonce}.` });
    assert.equal(result.move.reason, 'provider_accepted', 'architecture_not_provider_accepted');
    assert.equal(result.move.answerContainsNonce, true, 'architecture_end_marker_missing');
    const finalIntake = await workerGet(`/debug/intake/${CHAT_ID}`, secrets.agent);
    assert.equal(finalIntake.busy, false, 'intake_busy_at_final');
    assert.deepEqual(controlPlaneBarrierCounts(finalIntake), { busyRequestCount: 0, unresolvedLaunchCount: 0 }, 'barrier_not_clean_at_final');
    await checkpoint('passed', { ok: true, finalIntake: summarizeIntake(finalIntake) });
    console.log(`PASS architecture parts=${result.move.parts} chars=${result.move.answerLength} digest=${result.move.answerSha256}`);
    return;
  }
  const nonce1 = `B1-${randomBytes(5).toString('hex')}`;
  const first = await runMove({
    label: 'move-1-store-context',
    nonce: nonce1,
    askText: `Контрольная метка для следующего вопроса: ${nonce1}. Ответь «Принято». Не сохраняй метку в долговременную память.`,
  });
  assert.equal(first.move.status, 'sent', 'move1_not_sent');
  assert.equal(first.move.reason, 'provider_accepted', 'move1_not_provider_accepted');
  await checkpoint('move1_delivered');

  const nonce2 = `B1-${randomBytes(5).toString('hex')}`;
  const second = await runMove({
    label: 'move-2-recall-context',
    nonce: null,
    askText: 'Какая контрольная метка была в моём непосредственно предыдущем сообщении? Ответь только меткой из истории этой беседы. Не ищи её в долговременной памяти.',
  });
  assert.equal(second.move.status, 'sent', 'move2_not_sent');
  assert.equal(second.move.reason, 'provider_accepted', 'move2_not_provider_accepted');
  // Context-preservation oracle: the second answer must carry the first
  // turn's nonce — deterministic, no judgement involved.
  assert.ok(second.answerText.includes(nonce1), 'context_lost_move2_answer_misses_nonce');

  const finalIntake = await workerGet(`/debug/intake/${CHAT_ID}`, secrets.agent);
  assert.equal(finalIntake.busy, false, 'intake_busy_at_final');
  assert.deepEqual(controlPlaneBarrierCounts(finalIntake), { busyRequestCount: 0, unresolvedLaunchCount: 0 }, 'barrier_not_clean_at_final');
  assert.equal(finalIntake.stranded, false, 'intake_stranded_at_final');

  await checkpoint('passed', {
    ok: true,
    finalIntake: summarizeIntake(finalIntake),
    contextPreserved: true,
    recalledNonce: nonce1,
  });
  console.log(`PASS lane=${LANE} bot=${EXPECTED_BOT_USERNAME} buildSha=${evidence.buildSha} ` +
    `moves=${evidence.moves.map(m => `${m.deliveryId}->${m.providerMessageId}`).join(',')} ` +
    `contextPreserved=true evidence=${EVIDENCE_PATH}`);
}

main().catch(async error => {
  const state = fail(evidence.phase, error);
  let finalIntake = null;
  try {
    finalIntake = summarizeIntake(await workerGet(`/debug/intake/${CHAT_ID}`, secrets.agent));
  } catch { /* debug read failed during failure handling — keep null */ }
  await checkpoint(`failed:${state.phase}`, finalIntake ? { finalIntake } : {});
  console.error(`FAIL phase=${state.phase} error=${state.error} evidence=${EVIDENCE_PATH}`);
  process.exitCode = 1;
});
