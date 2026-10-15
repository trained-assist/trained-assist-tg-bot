import { createHash } from 'node:crypto';
import { it, expect } from 'vitest';
import { runParagraphDeliverySmoke } from '../tools/paragraph-delivery-smoke.mjs';
it('uses a fixed account and one immutable payload, waits for all parts and verifies replay', async () => {
  let payload;let calls = 0;
  const report = await runParagraphDeliverySmoke({ AGENT_SECRET: 'fixture', EXPECTED_BUILD_SHA: 'a'.repeat(40) }, async (url, init) => {
    if (url.endsWith('/health')) return Response.json({ buildSha: 'a'.repeat(40) });
    if (url.includes('/debug/deliveries')) return Response.json({ deliveries: [{ deliveryId: payload.deliveryId,
      status: 'sent', partCount: 5, sentParts: 5, providerMessageIds: [1, 2, 3, 4, 5],
      textCharacterCount: payload.message.text.length, textSha256: createHash('sha256').update(payload.message.text).digest('hex') }] });
    const next = JSON.parse(init.body);
    expect(next.destinationId).toBe('1714048');expect(next.message.text.length).toBeGreaterThan(4000);
    if (payload) expect(next).toEqual(payload);payload = next;calls++;
    return calls < 5 ? Response.json({ outcome: 'pending' }, { status: 503 })
      : Response.json({ providerMessageId: 1, duplicate: calls > 5 });
  }, async () => {});
  expect(report).toMatchObject({ ok: true, parts: 5, sentParts: 5, replaySameAcknowledgement: true });
  expect(JSON.stringify(report)).not.toContain(payload.message.text);
  expect(JSON.stringify(report)).not.toContain('fixture');
});
it('stops on an ambiguous provider outcome and does not invent an acknowledgement', async () => {
  let calls = 0;
  const report = await runParagraphDeliverySmoke({ AGENT_SECRET: 'fixture', EXPECTED_BUILD_SHA: 'a'.repeat(40) }, async url => {
    if (url.endsWith('/health')) return Response.json({ buildSha: 'a'.repeat(40) });
    calls++;return Response.json({ outcome: 'unknown' });
  });
  expect(report.ok).toBe(false);expect(calls).toBe(1);
  expect(report.reason).toBe('send_complete_result');
});
