import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ControlPlaneClient } from '../src/sandbox-tg/control-plane-client.js';

describe('sandbox control-plane principal authentication', () => {
  const secret = 'integration-test-secret';
  const principalId = 'sandbox-integration';
  const principalSignature = createHmac('sha256', secret).update(principalId).digest('hex');

  function clientFor(overrides = {}) {
    return new ControlPlaneClient({
      controlPlaneUrl: 'https://control-plane.test',
      principalId,
      principalSignature,
      requestTimeoutMs: 1000,
      ...overrides,
    }, {
      fetchImpl: async (input, options) => {
        const headers = options.headers;
        const expected = createHmac('sha256', secret).update(headers.get('x-principal')).digest('hex');
        const authorized = headers.get('x-principal-sig') === expected;
        expect(String(input)).not.toContain(principalSignature);
        expect(String(input)).not.toContain(secret);
        return Response.json({ authorized }, { status: authorized ? 200 : 401 });
      },
    });
  }

  it('sends the provisioned principal signature as a header', async () => {
    const response = await clientFor().request('GET', '/runner/health');
    expect(response.value.authorized).toBe(true);
    expect(clientFor().headers().get('authorization')).toBeNull();
  });

  it('cannot reuse a signature with a different principal', async () => {
    await expect(clientFor({ principalId: 'another-principal' }).request('GET', '/runner/health'))
      .rejects.toMatchObject({ status: 401 });
  });

  it('does not invent a signature when the binding is missing', async () => {
    await expect(clientFor({ principalSignature: null }).request('GET', '/runner/health'))
      .rejects.toMatchObject({ status: 401 });
  });
});
