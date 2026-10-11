import { describe, expect, it } from 'vitest';
import { dispatchCpSandboxCleanup } from '../tools/dispatch-cp-sandbox-cleanup.mjs';

const requestId = 'a6fd2e68-798a-49a0-a69a-d3f9629515c4';
const title = `Telegram UX sandbox cleanup ${requestId}`;

describe('dispatchCpSandboxCleanup', () => {
  it('correlates the exact cleanup run and waits for success', async () => {
    let now = 1_000;
    let listingCount = 0;
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/actions/workflows/cleanup-telegram-ux-sandbox.yml')) {
        return Response.json({ id: 77 });
      }
      if (String(url).includes('/runs?')) {
        listingCount += 1;
        return Response.json({ workflow_runs: listingCount < 2 ? [] : [{ id: 88, event: 'workflow_dispatch',
          head_branch: 'main', display_title: title }] });
      }
      if (String(url).endsWith('/dispatches')) return new Response(null, { status: 204 });
      if (String(url).endsWith('/actions/runs/88')) return Response.json({ id: 88,
        status: 'completed', conclusion: 'success', html_url: 'https://github.com/example/run/88' });
      throw new Error('unexpected URL');
    };
    const result = await dispatchCpSandboxCleanup({ token: 'test-token', requestId, runnerTaskIds: 'ut-test',
      fetchImpl, nowImpl: () => now, sleepImpl: async ms => { now += ms; } });
    expect(result).toEqual({ requestId, runId: 88, url: 'https://github.com/example/run/88', conclusion: 'success' });
    const dispatch = calls.find(call => call.url.endsWith('/dispatches'));
    expect(JSON.parse(dispatch.init.body)).toEqual({ ref: 'main', inputs: { request_id: requestId, runner_task_ids: 'ut-test' } });
    expect(dispatch.init.headers.authorization).toBe('Bearer test-token');
  });

  it('does not accept a failed cleanup workflow as success', async () => {
    let now = 1_000;
    let listingCount = 0;
    const fetchImpl = async url => {
      const value = String(url);
      if (value.endsWith('/actions/workflows/cleanup-telegram-ux-sandbox.yml')) return Response.json({ id: 77 });
      if (value.includes('/runs?')) {
        listingCount += 1;
        return Response.json({ workflow_runs: listingCount < 2 ? [] : [{ id: 88, event: 'workflow_dispatch',
          head_branch: 'main', display_title: title }] });
      }
      if (value.endsWith('/dispatches')) return new Response(null, { status: 204 });
      if (value.endsWith('/actions/runs/88')) return Response.json({ id: 88,
        status: 'completed', conclusion: 'failure' });
      throw new Error('unexpected URL');
    };
    await expect(dispatchCpSandboxCleanup({ token: 'test-token', requestId, fetchImpl,
      nowImpl: () => now, sleepImpl: async ms => { now += ms; } })).rejects.toThrow('cleanup_workflow_failure');
  });

  it('fails before network access when the cross-repository token is absent', async () => {
    let requested = false;
    await expect(dispatchCpSandboxCleanup({ token: '', requestId,
      fetchImpl: async () => { requested = true; } })).rejects.toThrow('cleanup_github_token_missing');
    expect(requested).toBe(false);
  });
});
