import assert from 'node:assert/strict';

export function assertSandboxStateEmpty(cp, tg, cpStateTables) {
  for (const name of cpStateTables) {
    assert.equal(Number(cp[name] ?? 0), 0, `CP sandbox not empty: ${name}=${cp[name]}`);
  }
  // intakeBuffers is the number of Durable Objects inspected, including empty
  // objects discovered through the immutable cutover manifest. Only stored
  // keys represent leftover buffered state.
  for (const name of ['sessionAndRetryKeys', 'sandboxUserKeys', 'durableObjectKeys', 'acceptOnlyKeys']) {
    assert.equal(Number(tg[name] ?? 0), 0, `TG sandbox not empty: ${name}=${tg[name]}`);
  }
  assert.equal(tg.active, false);
}
