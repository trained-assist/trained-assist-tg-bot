import { describe, expect, it } from 'vitest';
import { buildSandboxDeliveryCutoverManifest } from '../scripts/cloudflare/provision-sandbox-delivery-cutover-v2.mjs';

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
  it('tombstones all CP tasks and inventories each legacy delivery before provisioning', () => {
    const manifest = buildSandboxDeliveryCutoverManifest({ taskRows, deliveryRows,
      receiptRows: [{ taskId: 'ut-legacy', deliveryId: 'receipt:request-1' }], testChatId: '-123', cutoverAt });
    expect(manifest.oldTaskIds).toEqual(['ut-cp-1', 'ut-cp-2', 'ut-legacy']);
    expect(manifest.deliveries).toHaveLength(2);
    expect(manifest.deliveries[1]).toMatchObject({ providerMessageId: 502, observedProviderMessageIds: [502, 503] });
    expect(manifest.deliveries[0].destination).toEqual({ chatId: -123, threadId: null });
  });

  it('refuses cross-chat, cross-profile, and unmatched receipt evidence', () => {
    const build = overrides => buildSandboxDeliveryCutoverManifest({ taskRows, deliveryRows, receiptRows: [],
      testChatId: '-123', cutoverAt, ...overrides });
    expect(() => build({ testChatId: '-999' })).toThrow('cutover_legacy_delivery_destination_mismatch');
    expect(() => build({ taskRows: [{ id: 'ut-foreign', profile_id: 'foreign' }] })).toThrow('cutover_cp_task_scope_invalid');
    expect(() => build({ receiptRows: [{ taskId: 'ut-legacy', deliveryId: 'receipt:missing' }] }))
      .toThrow('cutover_receipt_index_unmatched');
  });
});
