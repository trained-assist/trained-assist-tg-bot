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
  const text = parts.join('');
  assert.ok(text.length > 2000 && text.includes('\n\n'));
  assert.equal(text.length, delivery.textCharacterCount);
  assert.equal(createHash('sha256').update(text).digest('hex'), delivery.textSha256);
  return text;
}
