import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
export function verifyCompleteAnswer(delivery, parts) {
  assert.equal(delivery.status, 'sent');
  assert.ok(delivery.partCount > 1 && delivery.sentParts === delivery.partCount);
  assert.equal(parts.length, delivery.partCount);
  assert.equal(delivery.providerMessageIds?.length, delivery.partCount);
  assert.ok(delivery.providerMessageIds.every(id => Number.isSafeInteger(id) && id > 0));
  assert.equal(new Set(delivery.providerMessageIds).size, delivery.partCount);
  assert.ok(parts.every(text => typeof text === 'string' && text.length > 0 && text.length <= 2000));
  // Telegram may remove a paragraph separator at a message edge. Restore
  // only a uniform boundary separator, and accept it solely if the entire
  // original source length AND cryptographic digest match exactly.
  const text = ['', '\n\n', '\n', ' '].map(separator => parts.join(separator)).find(candidate =>
    candidate.length === delivery.textCharacterCount &&
    createHash('sha256').update(candidate).digest('hex') === delivery.textSha256);
  assert.ok(text && text.length > 2000 && text.includes('\n\n'), 'complete_source_digest_mismatch');
  return text;
}
