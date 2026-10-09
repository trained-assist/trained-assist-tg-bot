import { conversationKey } from '../conversation-context.js';
import { assembleInput } from '../input-assembly.js';
import { readTgSliceConfig } from '../sandbox-tg/config.js';
import { ControlPlaneClient } from '../sandbox-tg/control-plane-client.js';
import { KvConversationStore, ConversationIndex } from '../sandbox-tg/conversation.js';
import { TgDeliveryOwnerClient } from '../sandbox-tg/delivery-owner.js';

export function controlPlaneClient(env) {
  const config = readTgSliceConfig(env);
  return new ControlPlaneClient(config, {
    fetchImpl: env.CONTROL_PLANE_SERVICE?.fetch.bind(env.CONTROL_PLANE_SERVICE),
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
      ? 'Определение маршрута недоступно; запрос сохранён. Готовлю запуск исполнителя.'
      : 'Определение маршрута недоступно; запрос сохранён, запуск исполнителя не подтверждён.' });
}

async function digest(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function runControlPlaneTask(env, input) {
  const config = readTgSliceConfig(env);
  if (!env.INTAKE || !env.TG_SLICE || !input.requestId || !input.sessionId) throw new Error('control_plane_execution_not_configured');
  if (!config.allowedChats.includes(String(input.userId))) throw new Error('control_plane_chat_refused');
  if (config.chatProfiles[String(input.userId)] && config.chatProfiles[String(input.userId)] !== config.profileId) throw new Error('control_plane_profile_refused');
  if (input.fileRefs?.length || input.fileBase64 || input.inputItems?.some(item => item.msg?.fileRef || item.msg?.transcriptRef || item.msg?.photo || item.msg?.document || item.msg?.voice || item.msg?.audio || item.msg?.video)) {
    throw Object.assign(new Error('Вложения сохранены в накопителе, но их передача новому исполнителю ещё не подключена.'), { code: 'INTAKE_PREPARATION_FAILED' });
  }
  const scope = `${config.botUsername}:${config.profileId}:${input.userId}:${input.threadId ?? ''}`;
  const requestId = `tgcp-${await digest(`${scope}:${input.requestId}`)}`;
  const conversationId = `tg-${input.userId}${input.threadId == null ? '' : `-t${input.threadId}`}-s${(await digest(`${scope}:${input.sessionId}`)).slice(0, 24)}`;
  const inputItems = input.inputItems?.length
    ? input.inputItems.map(item => ({ text: assembleInput([item], false).task, artifactRefs: [] }))
    : [{ text: input.task ?? '', artifactRefs: [] }];
  if (!inputItems.some(item => item.text)) throw new Error('control_plane_empty_input');
  const envelope = {
    contractVersion: 1, requestId, profileId: config.profileId,
    conversationRef: conversationId, sessionId: config.sessionId,
    inputItems, waitTimeoutSec: null,
    workStyle: ['explore', 'answer', 'auto'].includes(input.workStyle) ? input.workStyle : 'auto',
    workStyleSource: input.workStyleSource === 'explicit' ? 'explicit' : 'default',
  };
  const stub = env.INTAKE.get(env.INTAKE.idFromName(conversationKey(input.userId, input.threadId)));
  const response = await stub.fetch('https://intake/snapshot', {
    method: 'POST', body: JSON.stringify({ items: input.inputItems ?? [], body: {
      username: input.username, requestId, task: input.task, initialMsgId: input.initialMsgId,
      controlPlaneEnvelope: envelope,
    } }),
  });
  if (!response.ok) throw new Error('control_plane_snapshot_failed');
  const saved = (await response.json()).body.controlPlaneEnvelope;
  if (!saved || saved.requestId !== requestId || saved.profileId !== config.profileId) throw new Error('control_plane_snapshot_scope_mismatch');
  const client = controlPlaneClient(env);
  const persisted = await stub.fetch(`https://intake/cp-acceptance?requestId=${encodeURIComponent(requestId)}`);
  if (!persisted.ok) throw new Error('control_plane_acceptance_read_failed');
  let receipt = (await persisted.json()).receipt;
  if (!receipt) {
    receipt = await client.intake({ requestId: saved.requestId, conversationId: saved.conversationRef,
      sessionId: saved.sessionId, inputItems: saved.inputItems, waitTimeoutSec: saved.waitTimeoutSec,
      workStyle: saved.workStyle ?? 'auto', workStyleSource: saved.workStyleSource ?? 'default' });
    const accepted = await stub.fetch('https://intake/cp-acceptance', {
      method: 'POST', body: JSON.stringify({ requestId, receipt }),
    });
    if (!accepted.ok) throw new Error('control_plane_acceptance_persist_failed');
  }
  if (receipt.requestId !== requestId || receipt.profileId !== config.profileId || !receipt.userTaskId || receipt.durable !== true) throw new Error('control_plane_receipt_scope_mismatch');
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
    await publishRoutingDegradation(env, receipt, routed, index.destination, deliveryConversationId);
  } catch { routingPending = true; }
  return { taskId: receipt.userTaskId, userTaskId: receipt.userTaskId, requestId, durable: true,
    controlPlane: true, routingPending };
}
