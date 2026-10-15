import { messageParts, COMPLETE_ANSWER_LIMIT } from '../lib/message-parts.js';
import { formattedAnswerParts } from '../lib/telegram-answer-format.js';
import { readTgSliceConfig, TgSliceConfigError, chatAllowed } from './config.js';
import { TelegramApi, TelegramApiError } from './telegram.js';
import { ControlPlaneClient, ControlPlaneError } from './control-plane-client.js';
import { sandboxControlPlaneFetch } from './operator-lane.js';

const reference = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(value);
const artifactReference = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value)
  && !value.split('/').some(part => part === '..') && !value.endsWith('/');
const artifactSourceFailureCode = error => {
  if (error instanceof ControlPlaneError) {
    const runnerStatus = error.status === 502 && typeof error.body?.reason === 'string'
      ? /\bHTTP_(\d{3})\b/.exec(error.body.reason)?.[1] : null;
    return runnerStatus ? `runner_http_${runnerStatus}` : `http_${error.status}`;
  }
  return ['TimeoutError', 'AbortError', 'TypeError'].includes(error?.name) ? error.name : 'operation_failed';
};
const documentDelivery = record => ['artifact', 'input-document'].includes(record.type);
const key = id => `delivery:${id}`;
const partKey = (id, index) => `message-part:${id}:${index}`;
const digest = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
const generation = record => Number(record.deliveryId.match(/:g(\d+)$/)?.[1] ?? 0);
const summary = record => record ? {
  deliveryId: record.deliveryId, userTaskId: record.userTaskId, status: record.status,
  attempts: record.attempts, providerMessageId: record.telegramMessageId ?? null,
  reason: record.status === 'sending' ? 'provider_outcome_not_recorded' : record.reason ?? null,
  generation: generation(record), chatId: record.destination.chatId,
  type: record.type, artifactName: record.type === 'artifact' ? record.artifact?.name ?? null : null,
  ...(record.type === 'artifact' && record.artifactSourceFailure ? { artifactSourceFailure: record.artifactSourceFailure } : {}),
  threadId: record.destination.threadId ?? null,
  legacyStatus: record.legacyStatus ?? null,
  ...(record.partCount ? { partCount: record.partCount, sentParts: record.nextPart, providerMessageIds: record.telegramMessageIds ?? [],
    textCharacterCount: record.textCharacterCount, textSha256: record.textSha256 } : {}),
  ...(record.displayTextSha256 ? { displayTextSha256: record.displayTextSha256,
    displayTextCharacterCount: record.displayTextCharacterCount } : {}),
} : null;

function productionEmptyCutoverManifest(botUsername) {
  return {
    version: 'tg-delivery-cutover-v1',
    botUsername,
    profileId: 'trained-assist-production',
    cutoverId: 'production-empty-cutover-v1',
    // Stable across Worker restarts so the ordinary production owner namespace
    // keeps the same immutable fingerprint from the moment the lane is enabled.
    cutoverAt: 1_700_000_000_000,
    oldTaskIds: [],
    deliveries: [],
  };
}

export function cutoverManifest(env, config = readTgSliceConfig(env)) {
  // The ordinary production lane starts from an empty delivery owner; no
  // legacy destinations are imported.
  if (config.productionMode) return productionEmptyCutoverManifest(config.botUsername);
  const raw = env.TG_SLICE_DELIVERY_CUTOVER_MANIFEST;
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > 65536) throw new TgSliceConfigError('cutover manifest required', 'TG_SLICE_DELIVERY_CUTOVER_MANIFEST');
  let manifest;
  try { manifest = JSON.parse(raw); } catch { throw new TgSliceConfigError('invalid cutover manifest', 'TG_SLICE_DELIVERY_CUTOVER_MANIFEST'); }
  const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(name => Object.hasOwn(value, name));
  if (!exact(manifest, ['version', 'botUsername', 'profileId', 'cutoverId', 'cutoverAt', 'oldTaskIds', 'deliveries']) ||
      manifest.version !== 'tg-delivery-cutover-v1' || manifest.botUsername !== config.botUsername || manifest.profileId !== config.profileId ||
      !reference(manifest.cutoverId) || !Number.isSafeInteger(manifest.cutoverAt) || manifest.cutoverAt <= 0 || manifest.cutoverAt > Date.now() ||
      !Array.isArray(manifest.oldTaskIds) || manifest.oldTaskIds.length > 256 || !manifest.oldTaskIds.every(reference) || new Set(manifest.oldTaskIds).size !== manifest.oldTaskIds.length ||
      !Array.isArray(manifest.deliveries) || manifest.deliveries.length > 256 || new Set(manifest.deliveries.map(record => record?.deliveryId)).size !== manifest.deliveries.length ||
      manifest.deliveries.some(record => !exact(record, ['deliveryId', 'userTaskId', 'destination', 'priorStatus', 'providerMessageId', 'attempts',
        ...(Object.hasOwn(record ?? {}, 'history') ? ['history'] : []), ...(Object.hasOwn(record ?? {}, 'observedProviderMessageIds') ? ['observedProviderMessageIds'] : [])]) ||
        !reference(record.deliveryId) || !manifest.oldTaskIds.includes(record.userTaskId) ||
        !exact(record.destination, ['chatId', 'threadId']) || !Number.isSafeInteger(record.destination.chatId) || !chatAllowed(config, record.destination.chatId) ||
        (record.destination.threadId !== null && (!Number.isSafeInteger(record.destination.threadId) || record.destination.threadId <= 0)) ||
        !['pending', 'retrying', 'sending', 'sent', 'dead', 'unknown', 'quarantined'].includes(record.priorStatus) ||
        (record.providerMessageId !== null && (!Number.isSafeInteger(record.providerMessageId) || record.providerMessageId <= 0)) ||
        !Number.isInteger(record.attempts) || record.attempts < 0 || record.attempts > 20 ||
        (record.history !== undefined && (!Array.isArray(record.history) || record.history.length > 20 || record.history.some(entry =>
          !exact(entry, ['at', 'status']) || !Number.isSafeInteger(entry.at) || entry.at <= 0 || !Number.isInteger(entry.status) || entry.status < 0 || entry.status > 599))) ||
        (record.observedProviderMessageIds !== undefined && (!Array.isArray(record.observedProviderMessageIds) || record.observedProviderMessageIds.length > 20 ||
          record.observedProviderMessageIds.some(value => !Number.isSafeInteger(value) || value <= 0) || new Set(record.observedProviderMessageIds).size !== record.observedProviderMessageIds.length)))) {
    throw new TgSliceConfigError('invalid cutover manifest', 'TG_SLICE_DELIVERY_CUTOVER_MANIFEST');
  }
  return { version: manifest.version, botUsername: manifest.botUsername, profileId: manifest.profileId,
    cutoverId: manifest.cutoverId, cutoverAt: manifest.cutoverAt, oldTaskIds: [...manifest.oldTaskIds].sort(),
    deliveries: manifest.deliveries.map(record => ({ deliveryId: record.deliveryId, userTaskId: record.userTaskId,
      destination: { chatId: record.destination.chatId, threadId: record.destination.threadId }, priorStatus: record.priorStatus,
      providerMessageId: record.providerMessageId, attempts: record.attempts,
      history: (record.history ?? []).map(entry => ({ at: entry.at, status: entry.status })),
      observedProviderMessageIds: [...(record.observedProviderMessageIds ?? [])].sort((first, second) => first - second),
    })).sort((first, second) => first.deliveryId.localeCompare(second.deliveryId)) };
}

export class TgDeliveryOwner {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sendQueue = Promise.resolve();
    this.ready = state.blockConcurrencyWhile(async () => {
      const manifest = cutoverManifest(env);
      const fingerprint = JSON.stringify(manifest);
      const manifestDigest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(fingerprint)))].map(value => value.toString(16).padStart(2, '0')).join('');
      await state.storage.transaction(async storage => {
        const marker = await storage.get('cutover');
        if (marker && marker.fingerprint !== fingerprint) throw new Error('cutover_manifest_conflict');
        if (!marker) {
          if ((await storage.list({ prefix: 'delivery:' })).size) throw new Error('unmarked_owner_records');
          for (const taskId of manifest.oldTaskIds) await storage.put(`old-task:${taskId}`, true);
          for (const record of manifest.deliveries) await storage.put(key(record.deliveryId), {
            deliveryId: record.deliveryId, userTaskId: record.userTaskId, destination: record.destination,
            status: 'quarantined', legacyStatus: record.priorStatus, telegramMessageId: record.providerMessageId,
            legacyHistory: record.history, observedProviderMessageIds: record.observedProviderMessageIds,
            attempts: record.attempts, fingerprint: null, createdAt: manifest.cutoverAt, reason: 'operator_cutover_quarantine',
          });
          await storage.put('cutoverAt', manifest.cutoverAt);
          await storage.put('cutover', { fingerprint, cutoverId: manifest.cutoverId, manifestDigest, cutoverAt: manifest.cutoverAt,
            quarantinedTaskCount: manifest.oldTaskIds.length, quarantinedDeliveryCount: manifest.deliveries.length });
        }
        for (const [name, record] of await storage.list({ prefix: 'delivery:' })) {
          if (record.status === 'sending') await storage.put(name, { ...record, status: 'unknown', reason: 'owner_restart_inflight' });
        }
      });
    });
  }

  async fetch(request) {
    try { await this.ready; } catch { return Response.json({ error: 'delivery_owner_refused' }, { status: 503 }); }
      try {
        if (request.method !== 'POST' || new URL(request.url).hostname !== 'delivery-owner.internal') return Response.json({ error: 'invalid_owner_request' }, { status: 400 });
        const config = readTgSliceConfig(this.env);
        const body = await request.json();
        const route = new URL(request.url).pathname;
        if (JSON.stringify(cutoverManifest(this.env, config)) !== (await this.state.storage.get('cutover'))?.fingerprint) throw new Error();
        if (route === '/open') {
          const marker = await this.state.storage.get('cutover');
          const deliveryPaused = typeof body.deliveryPaused === 'boolean'
            ? body.deliveryPaused : this.env.TG_SLICE_DELIVERY_PAUSED !== 'false';
          const ingressPaused = typeof body.ingressPaused === 'boolean'
            ? body.ingressPaused : this.env.TG_SLICE_INGRESS_PAUSED === 'true';
          return Response.json({ ready: true, cutoverId: marker.cutoverId, manifestDigest: marker.manifestDigest,
            cutoverAt: marker.cutoverAt, quarantinedTaskCount: marker.quarantinedTaskCount,
            quarantinedDeliveryCount: marker.quarantinedDeliveryCount,
            paused: deliveryPaused, ingressPaused });
        }
        if (route === '/enqueue') return Response.json(await this.enqueue(body, config));
        if (route === '/discovery') {
          const current = await this.state.storage.get('discovery');
          return Response.json(current?.prefix === 'conv:tg-' ? {
            revision: current.revision, pageCursor: current.pageCursor, conversationKey: current.conversationKey,
            nextPageCursor: current.nextPageCursor, turnIndex: current.turnIndex,
          } : { revision: current?.revision ?? 0, pageCursor: null, conversationKey: null, nextPageCursor: null, turnIndex: 0 });
        }
        if (route === '/advance-discovery') {
          const next = body.next;
          if (!Number.isSafeInteger(body.revision) || body.revision < 0 || !next ||
              Object.keys(next).sort().join(',') !== 'conversationKey,nextPageCursor,pageCursor,turnIndex' ||
              !Number.isSafeInteger(next.turnIndex) || next.turnIndex < 0 ||
              ![next.pageCursor, next.nextPageCursor].every(value => value === null || typeof value === 'string' && value.length <= 2048) ||
              !(next.conversationKey === null || typeof next.conversationKey === 'string' && next.conversationKey.startsWith('conv:tg-') && next.conversationKey.length <= 512)) throw new Error();
          const advanced = await this.state.storage.transaction(async storage => {
            const stored = await storage.get('discovery');
            if ((stored?.revision ?? 0) !== body.revision) return false;
            const current = stored?.prefix === 'conv:tg-' ? stored : null;
            let turnIndex = next.turnIndex;
            if (current?.conversationKey && next.conversationKey === null) {
              await storage.put(`discovery-turn:${current.conversationKey}`, turnIndex);
              turnIndex = 0;
            } else if (!current?.conversationKey && next.conversationKey) {
              turnIndex = await storage.get(`discovery-turn:${next.conversationKey}`) ?? 0;
            }
            await storage.put('discovery', { ...next, turnIndex, revision: body.revision + 1, prefix: 'conv:tg-' });
            return true;
          });
          return Response.json({ advanced });
        }
        if (route === '/load' && reference(body.deliveryId)) return Response.json(await this.state.storage.get(key(body.deliveryId)) ?? null);
        if (route === '/read' && reference(body.taskId)) {
          const records = [...(await this.state.storage.list({ prefix: 'delivery:' })).values()].filter(record => record.userTaskId === body.taskId);
          const receipt = records.find(record => record.deliveryId.startsWith('receipt:')) ?? records.find(record => record.deliveryId === body.taskId);
          const terminal = records.filter(record => record.deliveryId.startsWith('terminal:')).sort((first, second) => generation(second) - generation(first))[0];
          if (records.some(record => !chatAllowed(config, record.destination.chatId))) return Response.json({ error: 'chat_not_allowed' }, { status: 403 });
          const terminalSummary = summary(terminal);
          if (terminalSummary && terminal?.type === 'message' && typeof terminal.text === 'string') {
            terminalSummary.textCharacterCount = terminal.textCharacterCount ?? terminal.text.length;
            terminalSummary.textSha256 = terminal.textSha256 ?? await digest(terminal.text);
          }
          const response = { receipt: summary(receipt), terminal: terminalSummary };
          if (body.includeArtifacts === true) response.artifacts = records
            .filter(record => record.type === 'artifact')
            .map(summary)
            .sort((first, second) => first.deliveryId.localeCompare(second.deliveryId));
          return Response.json(response);
        }
        if (route === '/list-deliveries') {
          const chatId = Number(body.chatId);
          if (!Number.isSafeInteger(chatId)) return Response.json({ error: 'invalid_chatId' }, { status: 400 });
          if (!chatAllowed(config, chatId)) return Response.json({ error: 'chat_not_allowed' }, { status: 403 });
          const limit = Number.isSafeInteger(body.limit) && body.limit > 0 ? Math.min(body.limit, 100) : 20;
          const records = [...(await this.state.storage.list({ prefix: 'delivery:' })).values()]
            .filter(record => Number(record.destination?.chatId) === chatId)
            .sort((first, second) => (second.createdAt ?? 0) - (first.createdAt ?? 0))
            .slice(0, limit)
            .map(record => ({ ...summary(record), createdAt: record.createdAt ?? null, sentAt: record.sentAt ?? null }));
          return Response.json({ deliveries: records });
        }
        if (route === '/drain') {
          const deliveryPaused = typeof body.deliveryPaused === 'boolean'
            ? body.deliveryPaused : this.env.TG_SLICE_DELIVERY_PAUSED !== 'false';
          if (deliveryPaused) return Response.json({ drained: 0 });
          const operation = this.sendQueue.then(() => this.drain(config));
          this.sendQueue = operation.catch(() => {});
          return Response.json({ drained: await operation });
        }
        return Response.json({ error: 'invalid_owner_request' }, { status: 400 });
      } catch { return Response.json({ error: 'delivery_owner_refused' }, { status: 503 }); }
  }

  async enqueue(input, config) {
    const deliveryId = input.deliveryId ?? input.userTaskId;
    if (!reference(deliveryId) || !reference(input.userTaskId) || !Number.isSafeInteger(Number(input.destination?.chatId)) || !chatAllowed(config, input.destination?.chatId) ||
        !['message', 'launch', 'artifact', 'input-document'].includes(input.type) || typeof input.text !== 'string' || input.text.length > (documentDelivery(input) ? 4096 : COMPLETE_ANSWER_LIMIT)) throw new Error();
    if (documentDelivery(input)) {
      const item = input.artifact;
      if (!item || typeof item !== 'object' || !artifactReference(item.ref)
        || typeof item.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,199}$/.test(item.name)
        || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 1 || item.sizeBytes > 10 * 1024 * 1024
        || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)
        || typeof item.contentType !== 'string' || item.contentType.length < 1 || item.contentType.length > 100) throw new Error();
    } else if (input.artifact !== undefined) throw new Error();
    const payload = { deliveryId, userTaskId: input.userTaskId, conversationId: input.conversationId ?? null,
      destination: { chatId: Number(input.destination.chatId), threadId: input.destination.threadId ?? null },
      requestId: input.requestId ?? deliveryId, type: input.type, text: input.text, replyMarkup: input.replyMarkup ?? null,
      taskAcceptedAt: input.taskAcceptedAt ?? null, ...(documentDelivery(input) ? { artifact: input.artifact } : {}) };
    const parts = input.type === 'message' ? formattedAnswerParts(input.text)
      : (documentDelivery(input) ? [input.text] : messageParts(input.text)).map(text => ({ text, entities: [] }));
    const multipart = parts.length > 1;
    const legacyFingerprint = JSON.stringify(payload);
    const fingerprint = multipart ? `sha256:${await digest(legacyFingerprint)}` : legacyFingerprint;
    const textSha256 = multipart ? await digest(payload.text) : null;
    const displayText = input.type === 'message' ? parts.map(part => part.text).join('') : null;
    const displayTextSha256 = displayText !== null ? await digest(displayText) : null;
    return this.state.storage.transaction(async storage => {
      const existing = await storage.get(key(deliveryId));
      if (existing) {
        if (existing.fingerprint !== null && existing.fingerprint !== fingerprint && existing.fingerprint !== legacyFingerprint) throw new Error();
        if (existing.userTaskId !== payload.userTaskId || existing.conversationId !== payload.conversationId
          || existing.type !== payload.type || String(existing.destination.chatId) !== String(payload.destination.chatId)
          || existing.destination.threadId !== payload.destination.threadId) throw new Error();
        return { record: existing, duplicate: true };
      }
      const cutoverAt = await storage.get('cutoverAt');
      const eligible = !await storage.get(`old-task:${payload.userTaskId}`) && Number.isSafeInteger(payload.taskAcceptedAt) && payload.taskAcceptedAt >= cutoverAt && payload.taskAcceptedAt <= Date.now();
      const record = { ...payload, ...(multipart ? { text: '', partCount: parts.length, nextPart: 0, partAttempts: 0, telegramMessageIds: [],
        textCharacterCount: payload.text.length, textSha256 } : {}), fingerprint, status: eligible ? 'pending' : 'quarantined',
        ...(displayText !== null ? { displayTextCharacterCount: displayText.length,
          displayTextSha256, ...(!multipart ? { rendered: parts[0] } : {}) } : {}),
        attempts: 0, createdAt: Date.now(), ...(!eligible ? { reason: 'precutover_or_unproven_task' } : {}) };
      if (multipart) for (const [index, part] of parts.entries()) await storage.put(partKey(deliveryId, index), part);
      await storage.put(key(deliveryId), record);
      return { record, duplicate: false };
    });
  }

  async drain(config) {
    const claim = await this.state.storage.transaction(async storage => {
      const records = [...(await storage.list({ prefix: 'delivery:' })).values()].sort((first, second) => first.createdAt - second.createdAt);
      const record = records.find(item => ['pending', 'retrying'].includes(item.status) && (item.nextAttemptAt ?? 0) <= Date.now());
      if (!record) return null;
      if (!chatAllowed(config, record.destination.chatId)) throw new Error();
      const claimed = { ...record, status: 'sending', attempts: record.attempts + 1,
        ...(record.partCount ? { partAttempts: (record.partAttempts ?? 0) + 1 } : {}), dispatchedAt: Date.now() };
      await storage.put(key(record.deliveryId), claimed);
      return claimed;
    });
    if (!claim) return 0;
    const api = new TelegramApi(config);
    let completion;
    let providerCalled = false;
    try {
      let result;
      if (documentDelivery(claim)) {
        const client = new ControlPlaneClient(config, { fetchImpl: sandboxControlPlaneFetch(this.env) });
        const downloaded = await client.artifact(claim.userTaskId, claim.artifact.ref);
        const actualSha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', downloaded.body))]
          .map(value => value.toString(16).padStart(2, '0')).join('');
        const expectedSha256 = claim.artifact.sha256.replace(/^sha256:/, '').toLowerCase();
        if (downloaded.filename !== claim.artifact.name || downloaded.sizeBytes !== claim.artifact.sizeBytes
          || downloaded.sha256?.toLowerCase() !== expectedSha256 || actualSha256 !== expectedSha256
          || downloaded.body.byteLength !== claim.artifact.sizeBytes) {
          completion = { ...claim, status: 'dead', reason: 'artifact_integrity_rejected', finishedAt: Date.now() };
          if (completion.status === 'pending' || completion.status === 'sent') delete completion.nextAttemptAt;
    await this.state.storage.put(key(claim.deliveryId), completion);
          return 1;
        }
        providerCalled = true;
        result = await api.sendDocument({ chatId: claim.destination.chatId, threadId: claim.destination.threadId,
          document: downloaded.body, filename: claim.artifact.name, caption: claim.type === 'input-document' ? claim.text : `📎 ${claim.artifact.name}`,
          contentType: downloaded.contentType ?? claim.artifact.contentType });
      } else {
        const stored = claim.partCount ? await this.state.storage.get(partKey(claim.deliveryId, claim.nextPart)) : claim.rendered ?? claim.text;
        const prepared = typeof stored === 'string' ? { text: stored, entities: [] } : stored;
        if (typeof prepared?.text !== 'string' || !Array.isArray(prepared.entities)) {
          await this.state.storage.put(key(claim.deliveryId), { ...claim, status: 'dead', reason: 'message_part_missing', finishedAt: Date.now() });
          return 1;
        }
        providerCalled = true;
        const send = entities => api.sendMessage({ chatId: claim.destination.chatId, threadId: claim.destination.threadId,
          text: prepared.text, entities,
          replyMarkup: !claim.partCount || claim.nextPart === claim.partCount - 1 ? claim.replyMarkup : null });
        try {
          result = await send(prepared.entities);
        } catch (error) {
          // A verified 400 means Telegram rejected the formatting before
          // delivery. Retry this same visible text without entities once.
          const entityRejected = prepared.entities.length > 0 && error instanceof TelegramApiError
            && error.payloadVerified && error.status === 400 && error.payload?.error_code === 400
            && /entit(?:y|ies)/i.test(String(error.payload.description ?? ''));
          if (!entityRejected) throw error;
          result = await send([]);
        }
      }
      if (!Number.isSafeInteger(result?.message_id) || result.message_id <= 0) throw new Error();
      if (claim.partCount) {
        const nextPart = claim.nextPart + 1;
        completion = { ...claim, nextPart, partAttempts: 0, telegramMessageIds: [...claim.telegramMessageIds, result.message_id],
          status: nextPart === claim.partCount ? 'sent' : 'pending', telegramMessageId: claim.telegramMessageId ?? result.message_id,
          ...(nextPart === claim.partCount ? { sentAt: Date.now() } : {}), reason: 'provider_accepted' };
      } else completion = { ...claim, status: 'sent', telegramMessageId: result.message_id, sentAt: Date.now(), reason: 'provider_accepted' };
    } catch (error) {
      const rejected = error instanceof TelegramApiError && error.payloadVerified === true && error.payload?.ok === false;
      const rateLimited = rejected && error.status === 429 && error.payload.error_code === 429;
      const permanentArtifactFailure = documentDelivery(claim) && error instanceof ControlPlaneError
        && [400, 404, 409, 413].includes(error.status);
      const retryArtifactRead = documentDelivery(claim) && !providerCalled && !permanentArtifactFailure;
      const artifactSourceFailure = retryArtifactRead || permanentArtifactFailure ? artifactSourceFailureCode(error) : null;
      const delay = Math.min(3600000, Math.max(config.deliveryRetryBaseMs, (error?.retryAfterSec ?? 1) * 1000));
      completion = { ...claim,
        status: permanentArtifactFailure ? 'dead' : retryArtifactRead || rateLimited
          ? ((claim.partCount ? claim.partAttempts : claim.attempts) >= config.deliveryMaxAttempts ? 'dead' : 'retrying') : 'unknown',
        reason: permanentArtifactFailure ? 'artifact_source_rejected' : retryArtifactRead ? 'artifact_source_unavailable'
          : rateLimited ? 'explicit_provider_429' : 'provider_outcome_unknown',
        ...(artifactSourceFailure ? { artifactSourceFailure } : {}),
        ...(!permanentArtifactFailure && (retryArtifactRead || rateLimited) ? { nextAttemptAt: Date.now() + delay } : {}) };
    }
    if (completion.status === 'pending' || completion.status === 'sent') delete completion.nextAttemptAt;
    await this.state.storage.put(key(claim.deliveryId), completion);
    return 1;
  }
}

export class TgDeliveryOwnerClient {
  constructor(env, config = readTgSliceConfig(env)) {
    this.env = env;
    const useV2 = Boolean(env.TG_DELIVERY_OWNER_V2?.idFromName && env.TG_DELIVERY_OWNER_V2?.get);
    const manifest = useV2 ? env.TG_SLICE_DELIVERY_CUTOVER_MANIFEST_V2 : env.TG_SLICE_DELIVERY_CUTOVER_MANIFEST;
    cutoverManifest({ ...env, TG_SLICE_DELIVERY_CUTOVER_MANIFEST: manifest }, config);
    const namespace = useV2 ? env.TG_DELIVERY_OWNER_V2 : env.TG_DELIVERY_OWNER;
    if (!namespace?.idFromName || !namespace?.get) throw new TgSliceConfigError('durable delivery owner required', useV2 ? 'TG_DELIVERY_OWNER_V2' : 'TG_DELIVERY_OWNER');
    const version = useV2 ? 'v2' : 'v1';
    this.stub = namespace.get(namespace.idFromName(`sandbox-delivery-${version}:${config.botUsername}`));
  }
  async call(route, body) {
    const response = await this.stub.fetch(new Request(`https://delivery-owner.internal/${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));
    if (!response.ok) throw Object.assign(new Error('delivery_owner_refused'), { status: response.status === 403 ? 403 : 503 });
    return response.json();
  }
  enqueue(record) { return this.call('enqueue', record); }
  load(deliveryId) { return this.call('load', { deliveryId }); }
  open() { return this.call('open', {
    deliveryPaused: this.env.TG_SLICE_DELIVERY_PAUSED !== 'false',
    ingressPaused: this.env.TG_SLICE_INGRESS_PAUSED === 'true',
  }); }
  load(deliveryId) { return this.call('load', { deliveryId }); }
  read(taskId, options = {}) { return this.call('read', { taskId, ...(options.includeArtifacts === true ? { includeArtifacts: true } : {}) }); }
  list(chatId, options = {}) { return this.call('list-deliveries', { chatId, ...(options.limit !== undefined ? { limit: options.limit } : {}) }); }
  discovery() { return this.call('discovery', {}); }
  async advanceDiscovery(revision, next) { return (await this.call('advance-discovery', { revision, next })).advanced; }
  async drain() { return (await this.call('drain', {
    deliveryPaused: this.env.TG_SLICE_DELIVERY_PAUSED !== 'false',
  })).drained; }
}

// Preserve the original owner for forensic evidence; an initialized manifest
// is immutable, so a corrected cutover starts in its own SQLite DO namespace.
export class TgDeliveryOwnerV2 extends TgDeliveryOwner {
  constructor(state, env) {
    super(state, { ...env, TG_SLICE_DELIVERY_CUTOVER_MANIFEST: env.TG_SLICE_DELIVERY_CUTOVER_MANIFEST_V2 });
  }
}
