import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(new URL('../.github/workflows/sandbox3-worker-e2e.yml', import.meta.url), 'utf8');

describe('sandbox3-worker-e2e paused lane preflight propagation (#649)', () => {
  it('waits at least 120s for the just-deployed paused revision to propagate (#649)', () => {
    expect(workflow).toMatch(/const deadline = Date\.now\(\) \+ 120_000;/);
    expect(workflow).toMatch(/await new Promise\(resolve => setTimeout\(resolve, 2_000\)\);/);
    expect(workflow).toContain('sandbox3_v1_delivery_owner_not_safely_paused');
    expect(workflow).toContain('state.paused === true');
  });
});
