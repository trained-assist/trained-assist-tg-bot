const baseUrl = 'https://trained-assist-tg-ux-sandbox.skillset-apply.workers.dev';

export async function readSandboxDeliveryCutover({ secret, fetchImpl = fetch }) {
  const token = String(secret ?? '').trim();
  if (!token) throw new Error('sandbox_cutover_read_token_missing');
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/operator/delivery-cutover`, {
      headers: { authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error('sandbox_delivery_cutover_unreachable');
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ready !== true || typeof body.cutoverId !== 'string'
    || !/^[a-f0-9]{64}$/.test(body.manifestDigest ?? '')
    || !Number.isSafeInteger(body.quarantinedTaskCount) || body.quarantinedTaskCount < 1
    || !Number.isSafeInteger(body.quarantinedDeliveryCount) || body.quarantinedDeliveryCount < 1
    || body.paused !== true) {
    throw new Error(`sandbox_delivery_cutover_not_ready:${response.status}`);
  }
  return {
    ok: true,
    worker: 'trained-assist-tg-ux-sandbox',
    cutoverId: body.cutoverId,
    manifestDigest: body.manifestDigest,
    quarantinedTaskCount: body.quarantinedTaskCount,
    quarantinedDeliveryCount: body.quarantinedDeliveryCount,
    paused: body.paused,
    providerCalled: false,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  readSandboxDeliveryCutover({ secret: process.env.TG_SANDBOX_CUTOVER_READ_TOKEN })
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
