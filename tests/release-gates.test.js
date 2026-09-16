import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
function jobs() {
  const entries = [...source.matchAll(/^  ([a-z][a-z0-9-]*):\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:\n|$(?![\s\S]))/gm)];
  const result = new Map();
  for (const [, name, body] of entries) {
    if (['push','pull_request'].includes(name)) continue;
    expect(result.has(name), `duplicate job ${name}`).toBe(false);
    result.set(name, body);
  }
  return result;
}
it('release graph has unique jobs, valid dependencies and no cycles', () => {
  const graph = jobs(); expect(graph.has('staging-gate')).toBe(true);
  const done = new Set();
  function visit(name, visiting = new Set()) {
    expect(graph.has(name), `missing dependency ${name}`).toBe(true);
    expect(visiting.has(name), `dependency cycle at ${name}`).toBe(false);
    if (done.has(name)) return;
    const body = graph.get(name), next = new Set([...visiting, name]);
    const needs = body.match(/^    needs: (.+)$/m)?.[1];
    for (const dep of (needs || '').replace(/[\[\]]/g,'').split(',').map(x=>x.trim()).filter(Boolean)) visit(dep, next);
    done.add(name);
  }
  for (const name of graph.keys()) visit(name);
});
it('production requires actual staging, smoke and scenarios; health verifies deployed revision', () => {
  const graph = jobs();
  expect(graph.get('deploy')).toContain('needs: [ci, staging-gate]');
  expect(graph.get('deploy-staging')).toContain('needs: [ci, scenario-gate]');
  expect(graph.get('deploy-staging')).toContain('BUILD_SHA:${{ github.sha }}');
  expect(graph.get('staging-gate')).toContain('needs: [ci, scenario-gate, deploy-staging, smoke-test-staging]');
  expect(graph.get('staging-gate')).toContain("all(r == 'success' for r in results)");
  expect(graph.get('smoke-test-staging')).toContain('["buildSha"] == "${{ github.sha }}"');
  expect(source).not.toContain('continue-on-error');
});
