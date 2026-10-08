import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleCleanupEvent, previewWorkerForBranch } from '../scripts/staging/cleanup-preview.mjs';

const repository = 'trained-assist/trained-assist-tg-bot';
const accountId = 'test-account';
const cloudflareBase = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts`;
const baseContext = {
  repository,
  githubToken: 'test-github-token',
  cloudflareToken: 'test-cloudflare-token',
  cloudflareBase,
  now: Date.parse('2026-10-08T00:00:00Z'),
};
const json = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });

afterEach(() => vi.restoreAllMocks());

describe('preview Worker cleanup', () => {
  it('uses the deploy workflow hash and protects main', () => {
    expect(previewWorkerForBranch('codex/preview cleanup')).toBe('ta-tg-staging-e90973f8b9fa');
    expect(previewWorkerForBranch('main')).toBeNull();
    expect(previewWorkerForBranch('')).toBeNull();
  });

  it('deletes only the matching same-repository closed-PR preview without force', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json([]))
      .mockResolvedValueOnce(json({ success: true, result: {} }));
    const result = await handleCleanupEvent({
      repository: { full_name: repository },
      pull_request: { head: { ref: 'fix/closed-preview', repo: { full_name: repository } } },
    }, { ...baseContext, eventName: 'pull_request', fetchImpl });
    const worker = previewWorkerForBranch('fix/closed-preview');
    expect(result[0]).toMatchObject({ status: 'deleted', worker });
    expect(fetchImpl.mock.calls[1][0]).toBe(`${cloudflareBase}/${worker}`);
    expect(fetchImpl.mock.calls[1][1].method).toBe('DELETE');
    expect(fetchImpl.mock.calls[1][0]).not.toContain('force=');
  });

  it('keeps a preview when another open PR still uses the branch', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json([{ number: 431 }]));
    const result = await handleCleanupEvent({
      repository: { full_name: repository },
      pull_request: { head: { ref: 'fix/shared-branch', repo: { full_name: repository } } },
    }, { ...baseContext, eventName: 'pull_request', fetchImpl });
    expect(result[0].status).toBe('preserved');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('ignores fork pull requests and tags', async () => {
    const fetchImpl = vi.fn();
    const fork = await handleCleanupEvent({
      repository: { full_name: repository },
      pull_request: { head: { ref: 'feature/fork', repo: { full_name: 'someone/fork' } } },
    }, { ...baseContext, eventName: 'pull_request', fetchImpl });
    const tag = await handleCleanupEvent({ repository: { full_name: repository }, ref_type: 'tag', ref: 'v1' },
      { ...baseContext, eventName: 'delete', fetchImpl });
    expect(fork[0].status).toBe('skipped');
    expect(tag[0].status).toBe('skipped');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('removes a deleted branch preview and protects the main preview', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json({ success: true, result: {} }));
    const result = await handleCleanupEvent({
      repository: { full_name: repository }, ref_type: 'branch', ref: 'fix/deleted-branch',
    }, { ...baseContext, eventName: 'delete', fetchImpl });
    expect(result[0].status).toBe('deleted');
    expect(fetchImpl.mock.calls[0][0]).toBe(`${cloudflareBase}/${previewWorkerForBranch('fix/deleted-branch')}`);
    const protectedResult = await handleCleanupEvent({
      repository: { full_name: repository }, ref_type: 'branch', ref: 'main',
    }, { ...baseContext, eventName: 'delete', fetchImpl });
    expect(protectedResult[0].status).toBe('protected');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('removes aged orphan previews and preserves active branches and main', async () => {
    const stale = previewWorkerForBranch('deleted/old-branch');
    const recent = previewWorkerForBranch('deleted/recent-branch');
    const active = previewWorkerForBranch('active/branch');
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json([{ name: 'main' }, { name: 'active/branch' }]))
      .mockResolvedValueOnce(json([]))
      .mockResolvedValueOnce(json({
        success: true,
        result: [
          { id: stale, modified_on: '2026-10-06T00:00:00Z' },
          { id: recent, modified_on: '2026-10-07T18:00:00Z' },
          { id: active, modified_on: '2026-10-06T00:00:00Z' },
          { id: 'ta-tg-staging-0d6e4079e367', modified_on: '2026-10-01T00:00:00Z' },
          { id: 'unrelated-worker', modified_on: '2026-10-01T00:00:00Z' },
        ],
        result_info: { total_pages: 1 },
      }))
      .mockResolvedValueOnce(json({ success: true, result: {} }));
    const outcomes = await handleCleanupEvent({ repository: { full_name: repository } }, {
      ...baseContext, eventName: 'schedule', fetchImpl,
    });
    expect(outcomes).toEqual([{ status: 'deleted', worker: stale }]);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(fetchImpl.mock.calls[3][0]).toBe(`${cloudflareBase}/${stale}`);
  });

  it('defaults manual reconciliation to dry-run', async () => {
    const stale = previewWorkerForBranch('deleted/old-branch');
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json([{ name: 'main' }]))
      .mockResolvedValueOnce(json([]))
      .mockResolvedValueOnce(json({ success: true, result: [{ id: stale, modified_on: '2026-10-06T00:00:00Z' }], result_info: { total_pages: 1 } }));
    const result = await handleCleanupEvent({ repository: { full_name: repository }, inputs: { dry_run: true } }, {
      ...baseContext, eventName: 'workflow_dispatch', fetchImpl,
    });
    expect(result).toEqual([{ status: 'would-delete', worker: stale }]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('fails closed when Cloudflare refuses deletion without force', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json({ success: false, errors: [{ code: 10072, message: 'external binding exists' }] }, 400));
    await expect(handleCleanupEvent({
      repository: { full_name: repository }, ref_type: 'branch', ref: 'fix/still-bound',
    }, { ...baseContext, eventName: 'delete', fetchImpl })).rejects.toThrow('10072: external binding exists');
    expect(fetchImpl.mock.calls[0][1].method).toBe('DELETE');
  });
});
