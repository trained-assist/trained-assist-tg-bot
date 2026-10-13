const DELIVERY_STATES = new Set(['pending', 'retrying', 'sending', 'sent', 'dead', 'unknown', 'quarantined']);
const safeCode = value => typeof value === 'string' && /^[a-z0-9_.:-]{1,100}$/i.test(value)
  ? value.toLowerCase() : null;

/** Return only bounded delivery metadata for the pinned prod-principal report. */
export function summarizeProdPrincipalDelivery(payload, httpStatus, expectedChatId) {
  const terminal = payload?.terminal && typeof payload.terminal === 'object' ? payload.terminal : null;
  const receipt = payload?.receipt && typeof payload.receipt === 'object' ? payload.receipt : null;
  const terminalStatus = DELIVERY_STATES.has(terminal?.status) ? terminal.status : null;
  const receiptStatus = DELIVERY_STATES.has(receipt?.status) ? receipt.status : null;
  return {
    httpStatus: Number.isInteger(httpStatus) ? httpStatus : null,
    errorCode: safeCode(payload?.error),
    receiptStatus,
    terminalStatus,
    terminalReasonCode: safeCode(terminal?.reason),
    recipientMatchesPinnedChat: String(payload?.chatId ?? '') === expectedChatId &&
      String(terminal?.chatId ?? '') === expectedChatId,
    providerMessageIdPresent: Number.isSafeInteger(terminal?.providerMessageId) && terminal.providerMessageId > 0,
    attempts: Number.isSafeInteger(terminal?.attempts) ? terminal.attempts : null,
  };
}
