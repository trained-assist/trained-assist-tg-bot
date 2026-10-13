import { describe, expect, it } from 'vitest';
import { summarizeProdPrincipalDelivery } from '../tools/prod-principal-evidence.mjs';

describe('production E2E delivery evidence', () => {
  it('reports bounded delivery state without exposing message text or identifiers', () => {
    expect(summarizeProdPrincipalDelivery({
      chatId: '1714048',
      receipt: { status: 'sent' },
      terminal: { status: 'dead', reason: 'provider_rejected', chatId: 1714048,
        providerMessageId: null, attempts: 3, text: 'private answer', deliveryId: 'private-id' },
      answer: 'private answer',
    }, 200, '1714048')).toEqual({
      httpStatus: 200,
      errorCode: null,
      receiptStatus: 'sent',
      terminalStatus: 'dead',
      terminalReasonCode: 'provider_rejected',
      recipientMatchesPinnedChat: true,
      providerMessageIdPresent: false,
      attempts: 3,
    });
  });

  it('redacts malformed statuses and refuses to claim the pinned recipient matches', () => {
    expect(summarizeProdPrincipalDelivery({
      chatId: 'other', terminal: { status: 'private details', reason: 'bad reason', chatId: 1714048 },
      error: 'unsafe details',
    }, 409, '1714048')).toEqual({
      httpStatus: 409,
      errorCode: null,
      receiptStatus: null,
      terminalStatus: null,
      terminalReasonCode: null,
      recipientMatchesPinnedChat: false,
      providerMessageIdPresent: false,
      attempts: null,
    });
  });
});
