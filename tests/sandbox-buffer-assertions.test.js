import { describe, expect, it } from 'vitest';
import { assertSandboxStateEmpty } from '../tools/sandbox-buffer-assertions.mjs';

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
});
