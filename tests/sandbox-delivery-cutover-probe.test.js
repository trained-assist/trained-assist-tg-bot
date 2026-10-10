import { describe, expect, it } from 'vitest';
import { readSandboxDeliveryCutover } from '../scripts/cloudflare/sandbox-delivery-cutover-probe.mjs';

const ready = { ready: true, cutoverId: 'sandbox-cutover-20261010', manifestDigest: 'a'.repeat(64),
  quarantinedTaskCount: 2, quarantinedDeliveryCount: 3, paused: true, ingressPaused: true };

describe('sandbox delivery cutover probe', () => {
  it('makes one authenticated read and emits only bounded cutover metadata', async () => {
    const calls = [];
    const result = await readSandboxDeliveryCutover({ secret: 'secret-value', fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return Response.json(ready);
    } });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://trained-assist-tg-ux-sandbox.skillset-apply.workers.dev/operator/delivery-cutover');
    expect(calls[0].options.headers).toEqual({ authorization: 'Bearer secret-value' });
    expect(calls[0].options.redirect).toBe('error');
    expect(result).toEqual({ ok: true, worker: 'trained-assist-tg-ux-sandbox', cutoverId: ready.cutoverId,
      manifestDigest: ready.manifestDigest, quarantinedTaskCount: 2, quarantinedDeliveryCount: 3,
      paused: true, ingressPaused: true, providerCalled: false });
  });

  it('fails closed on auth failure or malformed manifest evidence', async () => {
    await expect(readSandboxDeliveryCutover({ secret: 'x', fetchImpl: async () => Response.json({}, { status: 401 }) }))
      .rejects.toThrow('sandbox_delivery_cutover_not_ready:401');
    await expect(readSandboxDeliveryCutover({ secret: 'x', fetchImpl: async () => Response.json({ ...ready, paused: 'false' }) }))
      .rejects.toThrow('sandbox_delivery_cutover_not_ready:200');
    await expect(readSandboxDeliveryCutover({ secret: 'x', fetchImpl: async () => Response.json({ ...ready, paused: false }) }))
      .rejects.toThrow('sandbox_delivery_cutover_not_ready:200');
    await expect(readSandboxDeliveryCutover({ secret: 'x', fetchImpl: async () => Response.json({ ...ready, ingressPaused: false }) }))
      .rejects.toThrow('sandbox_delivery_cutover_not_ready:200');
    await expect(readSandboxDeliveryCutover({ secret: 'x', fetchImpl: async () => Response.json({ ...ready, quarantinedTaskCount: 0 }) }))
      .rejects.toThrow('sandbox_delivery_cutover_not_ready:200');
    await expect(readSandboxDeliveryCutover({ secret: 'x', fetchImpl: async () => Response.json({ ...ready, quarantinedDeliveryCount: 0 }) }))
      .rejects.toThrow('sandbox_delivery_cutover_not_ready:200');
  });
});
