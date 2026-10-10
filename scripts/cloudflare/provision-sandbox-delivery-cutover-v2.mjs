import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const ACCOUNT_ID = 'd740a05e9442c1d0feacae2dfc673e93';
const DATABASE_ID = '01d17f46-63e2-46bc-947d-9eda3e0bb697';
const KV_NAMESPACE_ID = '915ffeedb74440538009bdc1bd00d381';
const PROFILE_ID = 'integration-telegram-ux-v1';
const BOT_USERNAME = 'probability_cat_bot';
const CONFIG = 'wrangler.sandbox-tg-existing-ux.toml';
const REFERENCE = /^[A-Za-z0-9._:-]{1,200}$/;
const STATUSES = new Set(['pending', 'retrying', 'sending', 'sent', 'dead', 'unknown', 'quarantined']);

function requireValue(condition, code) {
  if (!condition) throw new Error(code);
}

function historyOf(value) {
  if (value === undefined) return undefined;
  requireValue(Array.isArray(value) && value.length <= 20, 'cutover_history_invalid');
  return value.map(entry => {
    requireValue(entry && Number.isSafeInteger(entry.at) && entry.at > 0
      && Number.isInteger(entry.status) && entry.status >= 0 && entry.status <= 599, 'cutover_history_invalid');
    return { at: entry.at, status: entry.status };
  });
}

function observedIdsOf(value) {
  if (value === undefined) return undefined;
  requireValue(Array.isArray(value) && value.length <= 20
    && value.every(id => Number.isSafeInteger(id) && id > 0)
    && new Set(value).size === value.length, 'cutover_provider_id_inventory_invalid');
  return [...value].sort((a, b) => a - b);
}

export function buildSandboxDeliveryCutoverManifest({ taskRows, deliveryRows, receiptRows, testChatId, cutoverAt }) {
  const chatId = Number(testChatId);
  requireValue(Number.isSafeInteger(chatId) && chatId !== 0, 'cutover_test_chat_invalid');
  requireValue(Number.isSafeInteger(cutoverAt) && cutoverAt > 0 && cutoverAt <= Date.now(), 'cutover_time_invalid');
  requireValue(Array.isArray(taskRows) && taskRows.length > 0 && taskRows.length <= 256, 'cutover_cp_task_inventory_invalid');
  requireValue(Array.isArray(deliveryRows) && deliveryRows.length <= 256, 'cutover_delivery_inventory_invalid');
  requireValue(Array.isArray(receiptRows) && receiptRows.length <= 256, 'cutover_receipt_inventory_invalid');

  const oldTaskIds = new Set();
  for (const row of taskRows) {
    requireValue(row?.profile_id === PROFILE_ID && typeof row.id === 'string' && REFERENCE.test(row.id), 'cutover_cp_task_scope_invalid');
    oldTaskIds.add(row.id);
  }

  const deliveries = [];
  const knownRecords = new Set();
  for (const row of deliveryRows) {
    const taskId = String(row?.record?.userTaskId ?? '');
    const deliveryId = String(row?.record?.deliveryId ?? row?.key?.slice('delivery:'.length) ?? '');
    const record = row?.record;
    const destinationChat = Number(record?.destination?.chatId);
    const rawThread = record?.destination?.threadId;
    const threadId = rawThread == null ? null : Number(rawThread);
    const status = String(record?.status ?? '');
    const attempts = Number(record?.attempts);
    const rawProviderId = record?.telegramMessageId;
    const providerMessageId = rawProviderId == null ? null : Number(rawProviderId);
    requireValue(REFERENCE.test(taskId) && REFERENCE.test(deliveryId)
      && row.key === `delivery:${deliveryId}` && row.key.slice('delivery:'.length) === deliveryId,
    'cutover_legacy_delivery_identity_invalid');
    requireValue(Number.isSafeInteger(destinationChat) && destinationChat !== 0
      && (threadId === null || Number.isSafeInteger(threadId) && threadId > 0),
    'cutover_legacy_delivery_destination_invalid');
    requireValue(STATUSES.has(status) && Number.isInteger(attempts) && attempts >= 0 && attempts <= 20,
      'cutover_legacy_delivery_state_invalid');
    requireValue(providerMessageId === null || Number.isSafeInteger(providerMessageId) && providerMessageId > 0,
      'cutover_legacy_provider_id_invalid');
    requireValue(!knownRecords.has(deliveryId), 'cutover_legacy_delivery_duplicate');
    knownRecords.add(deliveryId);
    oldTaskIds.add(taskId);
    const entry = { deliveryId, userTaskId: taskId,
      destination: { chatId: destinationChat, threadId }, priorStatus: status, providerMessageId, attempts };
    const history = historyOf(record.history);
    const observedProviderMessageIds = observedIdsOf(record.observedProviderMessageIds);
    if (history !== undefined) entry.history = history;
    if (observedProviderMessageIds !== undefined) entry.observedProviderMessageIds = observedProviderMessageIds;
    deliveries.push(entry);
  }

  for (const receipt of receiptRows) {
    const taskId = String(receipt?.taskId ?? '');
    const deliveryId = String(receipt?.deliveryId ?? '');
    requireValue(REFERENCE.test(taskId) && REFERENCE.test(deliveryId)
      && knownRecords.has(deliveryId)
      && deliveries.some(item => item.userTaskId === taskId && item.deliveryId === deliveryId),
    'cutover_receipt_index_unmatched');
    oldTaskIds.add(taskId);
  }

  requireValue(oldTaskIds.size <= 256 && oldTaskIds.size > 0, 'cutover_old_task_inventory_invalid');
  deliveries.sort((a, b) => a.deliveryId.localeCompare(b.deliveryId));
  const timestamp = new Date(cutoverAt).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const manifest = {
    version: 'tg-delivery-cutover-v1', botUsername: BOT_USERNAME, profileId: PROFILE_ID,
    cutoverId: `existing-ux-v2-${timestamp}`, cutoverAt,
    oldTaskIds: [...oldTaskIds].sort(), deliveries,
  };
  const bytes = Buffer.byteLength(JSON.stringify(manifest));
  requireValue(bytes <= 65536, 'cutover_manifest_too_large');
  return manifest;
}

async function cfJson(url, options = {}) {
  const token = String(process.env.CLOUDFLARE_API_TOKEN ?? '').trim();
  requireValue(token.length >= 32, 'cloudflare_api_token_missing');
  let response;
  try {
    response = await fetch(url, { ...options, headers: { authorization: `Bearer ${token}`,
      ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers }, signal: AbortSignal.timeout(15_000) });
  } catch { throw new Error('cloudflare_inventory_unreachable'); }
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success !== true) throw new Error(`cloudflare_inventory_failed:${response.status}`);
  return body;
}

async function inventoryAndBuild() {
  const base = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`;
  const operatorToken = String(process.env.TG_SANDBOX_CUTOVER_READ_TOKEN ?? '').trim();
  requireValue(operatorToken.length >= 32, 'sandbox_cutover_read_token_missing');
  let pauseResponse;
  try {
    pauseResponse = await fetch('https://trained-assist-tg-ux-sandbox.skillset-apply.workers.dev/operator/delivery-cutover-v1', {
      headers: { authorization: `Bearer ${operatorToken}` }, redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
  } catch { throw new Error('sandbox_delivery_pause_probe_unreachable'); }
  const pauseState = await pauseResponse.json().catch(() => ({}));
  requireValue(pauseResponse.ok && pauseState.ready === true && pauseState.paused === true && pauseState.ingressPaused === true,
    'sandbox_delivery_not_paused');

  const cutoverAt = Date.now();
  const d1 = await cfJson(`${base}/d1/database/${DATABASE_ID}/query`, {
    method: 'POST', body: JSON.stringify({ sql: 'SELECT id, profile_id FROM durable_tasks', params: [] }),
  });
  const taskRows = d1.result?.[0]?.results;
  requireValue(Array.isArray(taskRows), 'cutover_cp_task_inventory_invalid');

  async function list(prefix) {
    const rows = [];
    let cursor;
    do {
      const url = new URL(`${base}/storage/kv/namespaces/${KV_NAMESPACE_ID}/keys`);
      url.searchParams.set('prefix', prefix);
      url.searchParams.set('limit', '1000');
      if (cursor) url.searchParams.set('cursor', cursor);
      const result = await cfJson(url.toString());
      rows.push(...(result.result ?? []));
      cursor = result.result_info?.cursor || null;
      requireValue(rows.length <= 256, 'cutover_legacy_inventory_too_large');
    } while (cursor);
    return rows;
  }

  const deliveryKeys = await list('delivery:');
  const deliveryRows = [];
  for (const item of deliveryKeys) {
    const valueUrl = `${base}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${encodeURIComponent(item.name)}`;
    let response;
    try { response = await fetch(valueUrl, { headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` }, signal: AbortSignal.timeout(15_000) }); }
    catch { throw new Error('cloudflare_legacy_delivery_unreachable'); }
    if (!response.ok) throw new Error(`cloudflare_legacy_delivery_failed:${response.status}`);
    let record;
    try { record = JSON.parse(await response.text()); } catch { throw new Error('cutover_legacy_delivery_invalid'); }
    deliveryRows.push({ key: item.name, record });
  }

  const receiptKeys = await list('delivery-receipt:');
  const receiptRows = [];
  for (const item of receiptKeys) {
    const taskId = item.name.slice('delivery-receipt:'.length);
    const valueUrl = `${base}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${encodeURIComponent(item.name)}`;
    let response;
    try { response = await fetch(valueUrl, { headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` }, signal: AbortSignal.timeout(15_000) }); }
    catch { throw new Error('cloudflare_legacy_receipt_unreachable'); }
    if (!response.ok) throw new Error(`cloudflare_legacy_receipt_failed:${response.status}`);
    receiptRows.push({ taskId, deliveryId: (await response.text()).trim() });
  }

  const expectedChatId = Number(process.env.TG_STAGING_TEST_CHAT_ID);
  const expectedChatDeliveryCount = deliveryRows.filter(row => Number(row.record?.destination?.chatId) === expectedChatId).length;
  const manifest = buildSandboxDeliveryCutoverManifest({ taskRows, deliveryRows, receiptRows,
    testChatId: process.env.TG_STAGING_TEST_CHAT_ID, cutoverAt });
  return { manifest, digest: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    taskCount: taskRows.length, deliveryCount: deliveryRows.length, receiptCount: receiptRows.length, expectedChatDeliveryCount,
    foreignHistoricalDestinationCount: deliveryRows.length - expectedChatDeliveryCount };
}

async function main() {
  requireValue(process.env.GITHUB_REF === 'refs/heads/main', 'protected_main_required');
  const { manifest, digest, taskCount, deliveryCount, receiptCount, expectedChatDeliveryCount,
    foreignHistoricalDestinationCount } = await inventoryAndBuild();
  const secretPut = spawnSync('npx', ['wrangler', 'secret', 'put', 'TG_SLICE_DELIVERY_CUTOVER_MANIFEST_V2', '--config', CONFIG], {
    input: JSON.stringify(manifest), encoding: 'utf8', maxBuffer: 1024 * 1024,
  });
  if (secretPut.error || secretPut.status !== 0) throw new Error('cutover_manifest_secret_sync_failed');
  console.log(JSON.stringify({ ok: true, mode: 'provision_v2_manifest', cutoverId: manifest.cutoverId,
    manifestDigest: digest, quarantinedTaskCount: manifest.oldTaskIds.length,
    quarantinedDeliveryCount: deliveryCount, legacyReceiptIndexCount: receiptCount, canonicalCpTaskCount: taskCount,
    expectedChatDeliveryCount, foreignHistoricalDestinationCount }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
