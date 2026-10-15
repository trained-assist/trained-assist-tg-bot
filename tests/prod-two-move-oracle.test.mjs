import { expect, it } from 'vitest';
import { terminalDeliveriesSince } from '../tools/e2e-oracle.mjs';

it('waits for the terminal answer when a routing notice is delivered first', () => {
  const startedAt = 100;
  const deliveries = [
    { deliveryId: 'routing-degraded:ut-current', status: 'sent', providerMessageId: 12, createdAt: 120 },
    { deliveryId: 'terminal:ut-old:g1', status: 'sent', providerMessageId: 10, createdAt: 90 },
    { deliveryId: 'terminal:ut-current:g1', status: 'pending', providerMessageId: null, createdAt: 130 },
  ];

  expect(terminalDeliveriesSince(deliveries, startedAt)).toEqual([deliveries[2]]);
  expect(terminalDeliveriesSince([
    ...deliveries,
    { ...deliveries[2], status: 'sent', providerMessageId: 13 },
  ], startedAt).filter(delivery => delivery.status === 'sent')).toEqual([
    { ...deliveries[2], status: 'sent', providerMessageId: 13 },
  ]);
});
