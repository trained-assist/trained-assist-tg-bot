import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assertSandboxDeliveryCutoverV2Uninitialized, buildSandboxDeliveryCutoverManifest,
  sandboxDeliveryCutoverManifestDigest } from '../scripts/cloudflare/provision-sandbox-delivery-cutover-v2.mjs';
import { cutoverManifest } from '../src/sandbox-tg/delivery-owner.js';

const cutoverAt = Date.now() - 1_000;
const taskRows = [{ id: 'ut-cp-1', profile_id: 'integration-telegram-ux-v1' },
  { id: 'ut-cp-2', profile_id: 'integration-telegram-ux-v1' }];
const deliveryRows = [
  { key: 'delivery:receipt:request-1', record: { deliveryId: 'receipt:request-1', userTaskId: 'ut-legacy',
    destination: { chatId: -123, threadId: null }, status: 'sent', attempts: 1, telegramMessageId: 501 } },
  { key: 'delivery:ut-legacy', record: { userTaskId: 'ut-legacy', destination: { chatId: -123 },
    status: 'sent', attempts: 1, telegramMessageId: 502,
    history: [{ at: cutoverAt - 1, status: 200 }], observedProviderMessageIds: [502, 503] } },
];

describe('sandbox delivery cutover V2 manifest inventory', () => {
  it('uses an empty immutable manifest only for the pinned production E2E owner namespace', () => {
    const config = { botUsername: 'ptichka_status_bot', controlPlaneUrl: 'https://trained-assist-cp-production.skillset-apply.workers.dev',
      profileId: 'production-e2e-telegram-v1', openSandbox: false, allowedChats: ['1714048'] };
    const env = { TG_ACCEPT_ONLY_ENVIRONMENT: 'sandbox', TG_SANDBOX_TEST_API_ENABLED: 'true',
      TG_SANDBOX_BOT_USERNAME: 'ptichka_status_bot',
      CONTROL_PLANE_URL: 'https://trained-assist-cp-production.skillset-apply.workers.dev',
      CONTROL_PLANE_PRINCIPAL: 'production-e2e-telegram-v1', CONTROL_PLANE_PROFILE: 'production-e2e-telegram-v1',
      SESSION_NAMESPACE: 'integrator-production-e2e-v1',
      TG_SLICE_DELIVERY_CUTOVER_MANIFEST: 'sandbox3-manifest-is-not-valid-for-this-profile' };
    const manifest = cutoverManifest(env, config);
    expect(manifest).toMatchObject({ version: 'tg-delivery-cutover-v1', botUsername: 'ptichka_status_bot',
      profileId: 'production-e2e-telegram-v1', cutoverId: 'production-e2e-empty-cutover-v1',
      oldTaskIds: [], deliveries: [] });
    expect(cutoverManifest(env, config)).toEqual(manifest);

    expect(() => cutoverManifest({ ...env, SESSION_NAMESPACE: 'integrator-sandbox3-v1' }, config))
      .toThrow('invalid cutover manifest');
    expect(() => cutoverManifest({ ...env, TG_SANDBOX_TEST_API_ENABLED: 'false' }, config))
      .toThrow('invalid cutover manifest');
  });

  it('refuses to replace an already initialized immutable V2 manifest', () => {
    expect(() => assertSandboxDeliveryCutoverV2Uninitialized({ status: 200, body: { ready: true } }))
      .toThrow('sandbox_v2_cutover_already_initialized');
    expect(() => assertSandboxDeliveryCutoverV2Uninitialized({ status: 401, body: { error: 'unauthorized' } }))
      .toThrow('sandbox_v2_cutover_state_unexpected');
    expect(() => assertSandboxDeliveryCutoverV2Uninitialized({ status: 503, body: { error: 'delivery owner refused' } }))
      .not.toThrow();
  });

  it('tombstones all CP tasks and inventories each legacy delivery before provisioning', () => {
    const manifest = buildSandboxDeliveryCutoverManifest({ taskRows, deliveryRows,
      receiptRows: [{ taskId: 'ut-legacy', deliveryId: 'receipt:request-1' }], testChatId: '-123', cutoverAt });
    expect(manifest.oldTaskIds).toEqual(['ut-cp-1', 'ut-cp-2', 'ut-legacy']);
    expect(manifest.deliveries).toHaveLength(2);
    expect(manifest.deliveries[1]).toMatchObject({ providerMessageId: 502, observedProviderMessageIds: [502, 503] });
    expect(manifest.deliveries[0].destination).toEqual({ chatId: -123, threadId: null });
    const expectedCanonical = cutoverManifest({ TG_SLICE_DELIVERY_CUTOVER_MANIFEST: JSON.stringify(manifest) }, {
      botUsername: 'probability_cat_bot', profileId: 'integration-telegram-ux-v1', openSandbox: true, allowedChats: [],
    });
    expect(sandboxDeliveryCutoverManifestDigest(manifest)).toBe(
      createHash('sha256').update(JSON.stringify(expectedCanonical)).digest('hex'));
  });

  it('preserves historical destinations and refuses cross-profile or unmatched receipt evidence', () => {
    const build = overrides => buildSandboxDeliveryCutoverManifest({ taskRows, deliveryRows, receiptRows: [],
      testChatId: '-123', cutoverAt, ...overrides });
    const crossChatRows = structuredClone(deliveryRows);
    crossChatRows[1].record.destination.chatId = -999;
    const multiChat = build({ deliveryRows: crossChatRows });
    expect(multiChat.deliveries.map(item => item.destination.chatId)).toEqual([-123, -999]);
    expect(() => build({ taskRows: [{ id: 'ut-foreign', profile_id: 'foreign' }] })).toThrow('cutover_cp_task_scope_invalid');
    expect(() => build({ receiptRows: [{ taskId: 'ut-legacy', deliveryId: 'receipt:missing' }] }))
      .toThrow('cutover_receipt_index_unmatched');
  });
});
