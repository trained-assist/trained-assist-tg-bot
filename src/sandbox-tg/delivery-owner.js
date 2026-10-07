import { readTgSliceConfig, TgSliceConfigError, chatAllowed } from './config.js';
import { TelegramApi, TelegramApiError } from './telegram.js';

const reference = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(value);
const key = id => `delivery:${id}`;
const generation = record => Number(record.deliveryId.match(/:g(\d+)$/)?.[1] ?? 0);
const summary = record => record ? {
  deliveryId: record.deliveryId, userTaskId: record.userTaskId, status: record.status,
  attempts: record.attempts, providerMessageId: record.telegramMessageId ?? null,
  reason: record.status === 'sending' ? 'provider_outcome_not_recorded' : record.reason ?? null,
  generation: generation(record), chatId: record.destination.chatId,
  threadId: record.destination.threadId ?? null,
  legacyStatus: record.legacyStatus ?? null,
} : null;

export function cutoverManifest(env, config = readTgSliceConfig(env)) {
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
          return Response.json({ ready: true, cutoverId: marker.cutoverId, manifestDigest: marker.manifestDigest,
            cutoverAt: marker.cutoverAt, quarantinedTaskCount: marker.quarantinedTaskCount,
            quarantinedDeliveryCount: marker.quarantinedDeliveryCount, paused: this.env.TG_SLICE_DELIVERY_PAUSED !== 'false' });
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
          return Response.json({ receipt: summary(receipt), terminal: summary(terminal) });
        }
        if (route === '/drain') {
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
        !['message', 'launch'].includes(input.type) || typeof input.text !== 'string' || input.text.length > 4096) throw new Error();
    const payload = { deliveryId, userTaskId: input.userTaskId, conversationId: input.conversationId ?? null,
      destination: { chatId: Number(input.destination.chatId), threadId: input.destination.threadId ?? null },
      requestId: input.requestId ?? deliveryId, type: input.type, text: input.text, replyMarkup: input.replyMarkup ?? null,
      taskAcceptedAt: input.taskAcceptedAt ?? null };
    const fingerprint = JSON.stringify(payload);
    return this.state.storage.transaction(async storage => {
      const existing = await storage.get(key(deliveryId));
      if (existing) {
        if (existing.fingerprint !== null && existing.fingerprint !== fingerprint) throw new Error();
        if (existing.userTaskId !== payload.userTaskId || String(existing.destination.chatId) !== String(payload.destination.chatId) || existing.destination.threadId !== payload.destination.threadId) throw new Error();
        return { record: existing, duplicate: true };
      }
      const cutoverAt = await storage.get('cutoverAt');
      const eligible = !await storage.get(`old-task:${payload.userTaskId}`) && Number.isSafeInteger(payload.taskAcceptedAt) && payload.taskAcceptedAt >= cutoverAt && payload.taskAcceptedAt <= Date.now();
      const record = { ...payload, fingerprint, status: eligible ? 'pending' : 'quarantined',
        attempts: 0, createdAt: Date.now(), ...(!eligible ? { reason: 'precutover_or_unproven_task' } : {}) };
      await storage.put(key(deliveryId), record);
      return { record, duplicate: false };
    });
  }

  async drain(config) {
    if (this.env.TG_SLICE_DELIVERY_PAUSED !== 'false') return 0;
    const claim = await this.state.storage.transaction(async storage => {
      const records = [...(await storage.list({ prefix: 'delivery:' })).values()].sort((first, second) => first.createdAt - second.createdAt);
      const record = records.find(item => ['pending', 'retrying'].includes(item.status) && (item.nextAttemptAt ?? 0) <= Date.now());
      if (!record) return null;
      if (!chatAllowed(config, record.destination.chatId)) throw new Error();
      const claimed = { ...record, status: 'sending', attempts: record.attempts + 1, dispatchedAt: Date.now() };
      await storage.put(key(record.deliveryId), claimed);
      return claimed;
    });
    if (!claim) return 0;
    const api = new TelegramApi(config);
    let completion;
    try {
      const result = await api.sendMessage({ chatId: claim.destination.chatId, threadId: claim.destination.threadId,
        text: claim.text, replyMarkup: claim.replyMarkup });
      if (!Number.isSafeInteger(result?.message_id) || result.message_id <= 0) throw new Error();
      completion = { ...claim, status: 'sent', telegramMessageId: result.message_id, sentAt: Date.now(), reason: 'provider_accepted' };
    } catch (error) {
      const rejected = error instanceof TelegramApiError && error.payloadVerified === true && error.payload?.ok === false;
      const rateLimited = rejected && error.status === 429 && error.payload.error_code === 429;
      const delay = Math.min(3600000, Math.max(config.deliveryRetryBaseMs, (error?.retryAfterSec ?? 1) * 1000));
      completion = { ...claim, status: rateLimited ? (claim.attempts >= config.deliveryMaxAttempts ? 'dead' : 'retrying') : 'unknown',
        reason: rateLimited ? 'explicit_provider_429' : 'provider_outcome_unknown',
        ...(rateLimited ? { nextAttemptAt: Date.now() + delay } : {}) };
    }
    await this.state.storage.put(key(claim.deliveryId), completion);
    return 1;
  }
}

export class TgDeliveryOwnerClient {
  constructor(env, config = readTgSliceConfig(env)) {
    cutoverManifest(env, config);
    if (!env.TG_DELIVERY_OWNER?.idFromName || !env.TG_DELIVERY_OWNER?.get) throw new TgSliceConfigError('durable delivery owner required', 'TG_DELIVERY_OWNER');
    this.stub = env.TG_DELIVERY_OWNER.get(env.TG_DELIVERY_OWNER.idFromName(`sandbox-delivery-v1:${config.botUsername}`));
  }
  async call(route, body) {
    const response = await this.stub.fetch(new Request(`https://delivery-owner.internal/${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));
    if (!response.ok) throw Object.assign(new Error('delivery_owner_refused'), { status: response.status === 403 ? 403 : 503 });
    return response.json();
  }
  enqueue(record) { return this.call('enqueue', record); }
  open() { return this.call('open', {}); }
  load(deliveryId) { return this.call('load', { deliveryId }); }
  read(taskId) { return this.call('read', { taskId }); }
  discovery() { return this.call('discovery', {}); }
  async advanceDiscovery(revision, next) { return (await this.call('advance-discovery', { revision, next })).advanced; }
  async drain() { return (await this.call('drain', {})).drained; }
}
