import { describe, expect, it } from 'vitest';
import { assertSandboxStateEmpty, assertSandboxStateEventuallyEmpty } from '../tools/sandbox-buffer-assertions.mjs';

describe('sandbox buffer empty assertion', () => {
  const tables = ['durable_tasks', 'conversations'];

  it('allows empty Intake Durable Objects found in cutover manifests', () => {
    expect(() => assertSandboxStateEmpty(
      { durable_tasks: 0, conversations: 0 },
      { sessionAndRetryKeys: 0, sandboxUserKeys: 0, intakeBuffers: 1,
        durableObjectKeys: 0, acceptOnlyKeys: 0, active: false },
      tables,
    )).not.toThrow();
  });

  it('still rejects stored state in any inspected Intake Durable Object', () => {
    expect(() => assertSandboxStateEmpty(
      { durable_tasks: 0, conversations: 0 },
      { sessionAndRetryKeys: 0, sandboxUserKeys: 0, intakeBuffers: 1,
        durableObjectKeys: 1, acceptOnlyKeys: 0, active: false },
      tables,
    )).toThrow(/durableObjectKeys=1/);
  });

  it('rechecks transient KV list results until deletes become visible', async () => {
    let reads = 0;
    const retries = [];
    const result = await assertSandboxStateEventuallyEmpty(async () => {
      reads += 1;
      return {
        cp: { durable_tasks: 0, conversations: 0 },
        tg: { sessionAndRetryKeys: reads === 1 ? 1 : 0, sandboxUserKeys: 0,
          intakeBuffers: 1, durableObjectKeys: 0, acceptOnlyKeys: 0, active: false },
      };
    }, tables, { sleep: async () => {}, onRetry: detail => retries.push(detail) });
    expect(reads).toBe(2);
    expect(retries).toMatchObject([{ attempt: 1, remainingSessionKeys: 1 }]);
    expect(result.tg.sessionAndRetryKeys).toBe(0);
  });

  it('rechecks transient user-record list results until sandbox reset deletes become visible', async () => {
    let reads = 0;
    const retries = [];
    const result = await assertSandboxStateEventuallyEmpty(async () => {
      reads += 1;
      return {
        cp: { durable_tasks: 0, conversations: 0 },
        tg: { sessionAndRetryKeys: 0, sandboxUserKeys: reads === 1 ? 1 : 0,
          intakeBuffers: 1, durableObjectKeys: 0, acceptOnlyKeys: 0, active: false },
      };
    }, tables, { sleep: async () => {}, onRetry: detail => retries.push(detail) });
    expect(reads).toBe(2);
    expect(retries).toMatchObject([{ attempt: 1, remainingSessionKeys: 0, remainingSandboxUserKeys: 1 }]);
    expect(result.tg.sandboxUserKeys).toBe(0);
  });

  it('fails immediately on durable object state instead of retrying cleanup errors', async () => {
    let retries = 0;
    await expect(assertSandboxStateEventuallyEmpty(async () => ({
      cp: { durable_tasks: 0, conversations: 0 },
      tg: { sessionAndRetryKeys: 0, sandboxUserKeys: 0, durableObjectKeys: 1,
        acceptOnlyKeys: 0, active: false },
    }), tables, { sleep: async () => {}, onRetry: () => retries += 1 })).rejects.toThrow(/durableObjectKeys=1/);
    expect(retries).toBe(0);
  });
});
