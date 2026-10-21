import { conversationKey } from '../conversation-context.js';
import { assembleInput } from '../input-assembly.js';
import { chatAllowed, readTgSliceConfig } from '../sandbox-tg/config.js';
import { ControlPlaneClient } from '../sandbox-tg/control-plane-client.js';
import { KvConversationStore, ConversationIndex } from '../sandbox-tg/conversation.js';
import { TgDeliveryOwnerClient } from '../sandbox-tg/delivery-owner.js';
import { sandboxControlPlaneFetch } from '../sandbox-tg/operator-lane.js';
import { logLifecycleEvent } from './lifecycle-log.js';

export function controlPlaneClient(env) {
  const config = readTgSliceConfig(env);
  return new ControlPlaneClient(config, {
    fetchImpl: sandboxControlPlaneFetch(env),
  });
}

export async function publishRoutingDegradation(env, receipt, routed, destination, conversationId) {
  if (routed?.degraded !== true) return;
  const config = readTgSliceConfig(env);
  const outbox = new TgDeliveryOwnerClient(env, config);
  await outbox.enqueue({ deliveryId: `routing-degraded:${receipt.userTaskId}`,
    taskAcceptedAt: receipt.providerAcceptedAt, conversationId, userTaskId: receipt.userTaskId,
    destination, requestId: `routing-degraded:${receipt.userTaskId}`, type: 'message',
    text: routed.continuation?.issued === true
      ? 'По запросу отсутствует готовый рецепт. Отправляю на проработку.'
      : 'По запросу отсутствует готовый рецепт. Задача сохранена; запуск исполнителя пока не подтверждён.' });
}

async function digest(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function runControlPlaneTask(env, input) {
  const config = readTgSliceConfig(env);
  if (!env.INTAKE || !env.TG_SLICE || !input.requestId || !input.sessionId) throw Object.assign(new Error('control_plane_execution_not_configured'), { code: 'CONTROL_PLANE_NO_ADMISSION' });
  if (!chatAllowed(config, input.userId)) throw Object.assign(new Error('control_plane_chat_refused'), { code: 'CONTROL_PLANE_NO_ADMISSION' });
  if (config.chatProfiles[String(input.userId)] && config.chatProfiles[String(input.userId)] !== config.profileId) throw Object.assign(new Error('control_plane_profile_refused'), { code: 'CONTROL_PLANE_NO_ADMISSION' });
  const mediaInput = input.inputItems?.map(item => {
    const message = item.msg ?? {};
    const artifactManifest = item.artifactManifest ?? message.artifactManifest;
    const hasMedia = Boolean(message.fileRef || message.transcriptRef || message.photo || message.document || message.voice || message.audio || message.video);
    const validManifest = artifactManifest && artifactManifest.contractVersion === 1
      && artifactManifest.ownerProfileId === config.profileId
      && /^[a-f0-9]{64}$/.test(artifactManifest.ref ?? '')
      && /^[a-f0-9]{64}$/.test(artifactManifest.sha256 ?? '')
      && artifactManifest.version === artifactManifest.sha256
      && Number.isSafeInteger(artifactManifest.sizeBytes) && artifactManifest.sizeBytes > 0
      && typeof artifactManifest.name === 'string' && artifactManifest.name.length > 0
      && typeof artifactManifest.mediaType === 'string';
    return { item, artifactManifest, hasMedia, validManifest: Boolean(validManifest) };
  }) ?? [];
  if (input.fileRefs?.length || input.fileBase64 || mediaInput.some(({ hasMedia, artifactManifest, validManifest }) =>
    hasMedia && !validManifest || artifactManifest && !validManifest)) {
    throw Object.assign(new Error('Не удалось подтвердить вложение в хранилище; задача не запускалась.'), { code: 'INTAKE_PREPARATION_FAILED' });
  }
  const scope = `${config.botUsername}:${config.profileId}:${input.userId}:${input.threadId ?? ''}`;
  const requestId = `tgcp-${await digest(`${scope}:${input.requestId}`)}`;
  const routeContinue = input.routeContinue !== false;
  const routingOnly = input.routingOnly === true;
  const conversationId = `tg-${input.userId}${input.threadId == null ? '' : `-t${input.threadId}`}-s${(await digest(`${scope}:${input.sessionId}`)).slice(0, 24)}`;
  const inputItems = input.inputItems?.length
    ? mediaInput.map(({ item, artifactManifest }) => ({ text: assembleInput([item], false).task,
      ...(artifactManifest ? { artifacts: [artifactManifest] } : { artifactRefs: [] }) }))
    : [{ text: input.task ?? '', artifactRefs: [] }];
  if (!inputItems.some(item => item.text)) throw Object.assign(new Error('control_plane_empty_input'), { code: 'CONTROL_PLANE_NO_ADMISSION' });
  const envelope = {
    contractVersion: 1, requestId, profileId: config.profileId,
    conversationRef: conversationId, sessionId: config.sessionId,
    inputItems, waitTimeoutSec: null,
    workStyle: ['explore', 'answer', 'auto'].includes(input.workStyle) ? input.workStyle : 'auto',
    workStyleSource: input.workStyleSource === 'explicit' ? 'explicit' : 'default',
  };
  logLifecycleEvent({ event: 'tg.cp.snapshot_started', component: 'gateway',
    correlationId: requestId, requestId, status: 'started' }, env);
  const stub = env.INTAKE.get(env.INTAKE.idFromName(conversationKey(input.userId, input.threadId)));
  let response;
  try {
    response = await stub.fetch('https://intake/snapshot', {
      method: 'POST', body: JSON.stringify({ items: input.inputItems ?? [], body: {
        username: input.username, requestId, task: input.task, initialMsgId: input.initialMsgId,
        controlPlaneEnvelope: envelope,
      } }),
    });
  } catch {
    logLifecycleEvent({ event: 'tg.cp.snapshot_failed', component: 'gateway',
      correlationId: requestId, requestId, status: 'failed', reasonCode: 'collector_unavailable' }, env);
    throw new Error('control_plane_snapshot_failed');
  }
  if (!response.ok) {
    logLifecycleEvent({ event: 'tg.cp.snapshot_failed', component: 'gateway',
      correlationId: requestId, requestId, status: 'failed', reasonCode: 'snapshot_persist_failed' }, env);
    throw new Error('control_plane_snapshot_failed');
  }
  const snapshotPayload = await response.json().catch(() => null);
  const saved = snapshotPayload?.body?.controlPlaneEnvelope;
  if (!saved || saved.requestId !== requestId || saved.profileId !== config.profileId) {
    logLifecycleEvent({ event: 'tg.cp.snapshot_failed', component: 'gateway',
      correlationId: requestId, requestId, status: 'failed', reasonCode: 'snapshot_scope_mismatch' }, env);
    throw new Error('control_plane_snapshot_scope_mismatch');
  }
  logLifecycleEvent({ event: 'tg.cp.snapshot_persisted', component: 'gateway',
    correlationId: requestId, requestId, status: 'persisted' }, env);
  const client = controlPlaneClient(env);
  let persisted;
  try {
    persisted = await stub.fetch(`https://intake/cp-acceptance?requestId=${encodeURIComponent(requestId)}`);
  } catch {
    logLifecycleEvent({ event: 'tg.cp.receipt_read_failed', component: 'gateway',
      correlationId: requestId, requestId, status: 'failed', reasonCode: 'collector_unavailable' }, env);
    throw new Error('control_plane_acceptance_read_failed');
  }
  if (!persisted.ok) {
    logLifecycleEvent({ event: 'tg.cp.receipt_read_failed', component: 'gateway',
      correlationId: requestId, requestId, status: 'failed', reasonCode: 'receipt_read_failed' }, env);
    throw new Error('control_plane_acceptance_read_failed');
  }
  let receipt = (await persisted.json().catch(() => ({}))).receipt;
  if (!receipt) {
    try {
      receipt = await client.intake({ requestId: saved.requestId, conversationId: saved.conversationRef,
        sessionId: saved.sessionId, inputItems: saved.inputItems, waitTimeoutSec: saved.waitTimeoutSec,
        workStyle: saved.workStyle ?? 'auto', workStyleSource: saved.workStyleSource ?? 'default' });
    } catch (error) {
      logLifecycleEvent({ event: 'tg.cp.intake_failed', component: 'gateway',
        correlationId: requestId, requestId, status: 'failed',
        reasonCode: Number.isSafeInteger(error?.status) ? `cp_http_${error.status}` : 'cp_intake_unavailable' }, env);
      throw error;
    }
    let accepted;
    try {
      accepted = await stub.fetch('https://intake/cp-acceptance', {
        method: 'POST', body: JSON.stringify({ requestId, receipt, routingOnly }),
      });
    } catch {
      logLifecycleEvent({ event: 'tg.cp.receipt_persist_failed', component: 'gateway',
        correlationId: requestId, requestId, status: 'failed', reasonCode: 'collector_unavailable' }, env);
      throw new Error('control_plane_acceptance_persist_failed');
    }
    if (!accepted.ok) {
      logLifecycleEvent({ event: 'tg.cp.receipt_persist_failed', component: 'gateway',
        correlationId: requestId, requestId, status: 'failed', reasonCode: 'receipt_persist_failed' }, env);
      throw new Error('control_plane_acceptance_persist_failed');
    }
  }
  if (receipt.requestId !== requestId || receipt.profileId !== config.profileId || !receipt.userTaskId || receipt.durable !== true) throw new Error('control_plane_receipt_scope_mismatch');
  if (!routeContinue) {
    // Initialize the same delivery owner used by ordinary admissions before
    // returning a routing-only receipt (including after a cold restart).
    await new TgDeliveryOwnerClient(env, config).open();
    try {
      const routed = await client.route(receipt.userTaskId, { continue: false });
      if (!routed || typeof routed !== 'object' || Array.isArray(routed) || Object.hasOwn(routed, 'raw')) throw new Error('route_result_invalid');
      return { taskId: receipt.userTaskId, userTaskId: receipt.userTaskId, requestId, durable: true,
        controlPlane: true, routingPending: false, routed, receipt };
    } catch (error) {
      logLifecycleEvent({ event: 'tg.cp.route_pending', component: 'gateway', correlationId: requestId,
        requestId, taskId: receipt.userTaskId, status: 'pending', reasonCode: 'route_ack_unavailable' }, env);
      throw error;
    }
  }
  logLifecycleEvent({ event: 'tg.cp.task_accepted', component: 'gateway',
    correlationId: requestId, requestId, taskId: receipt.userTaskId, status: 'durable',
    duplicate: receipt.duplicate === true }, env);
  const store = new KvConversationStore(env.TG_SLICE);
  const deliveryConversationId = `${saved.conversationRef}-b${requestId.slice(-24)}`;
  const index = await store.load(deliveryConversationId) ?? new ConversationIndex(deliveryConversationId, config.profileId);
  index.destination = { chatId: input.userId, threadId: input.threadId ?? null };
  index.requestingBot = config.botUsername;
  if (!index.turns.some(turn => turn.requestId === requestId)) {
    index.turns.push({ kind: 'new', seq: index.turns.length + 1, requestId, userTaskId: receipt.userTaskId,
      createdAt: receipt.acceptedAt, providerAcceptedAt: receipt.providerAcceptedAt });
    await store.save(index);
  }
  const outbox = new TgDeliveryOwnerClient(env, config);
  await outbox.open();
  let routingPending = false;
  try {
    const routed = await client.route(receipt.userTaskId);
    logLifecycleEvent({ event: 'tg.cp.route_completed', component: 'gateway',
      correlationId: requestId, requestId, taskId: receipt.userTaskId,
      status: 'completed', ...(routed?.route ? { route: routed.route } : {}),
      ...(routed?.reasonCode ? { reasonCode: routed.reasonCode } : {}) }, env);
    await publishRoutingDegradation(env, receipt, routed, index.destination, deliveryConversationId);
  } catch {
    routingPending = true;
    logLifecycleEvent({ event: 'tg.cp.route_pending', component: 'gateway',
      correlationId: requestId, requestId, taskId: receipt.userTaskId,
      status: 'pending', reasonCode: 'route_ack_unavailable' }, env);
  }
  return { taskId: receipt.userTaskId, userTaskId: receipt.userTaskId, requestId, durable: true,
    controlPlane: true, routingPending };
}
