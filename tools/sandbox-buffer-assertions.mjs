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

export async function assertSandboxStateEventuallyEmpty(readState, cpStateTables, {
  maxAttempts = 13,
  delayMs = 5_000,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  onRetry = () => {},
} = {}) {
  for (let attempt = 1; ; attempt += 1) {
    const { cp, tg } = await readState();
    try {
      assertSandboxStateEmpty(cp, tg, cpStateTables);
      return { cp, tg };
    } catch (error) {
      const onlyKvVisibilityPending = cpStateTables.every(name => Number(cp[name] ?? 0) === 0) &&
        Number(tg.sessionAndRetryKeys) > 0 &&
        ['sandboxUserKeys', 'durableObjectKeys', 'acceptOnlyKeys'].every(name => Number(tg[name] ?? 0) === 0) &&
        tg.active === false;
      if (!onlyKvVisibilityPending || attempt >= maxAttempts) throw error;
      onRetry({ attempt, remainingSessionKeys: Number(tg.sessionAndRetryKeys), delayMs });
      await sleep(delayMs);
    }
  }
}
