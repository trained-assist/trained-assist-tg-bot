import { afterEach, expect, it, vi } from 'vitest';
import { getProjectDecision } from '../src/lib/agent-client.js';
const env = { AGENT_URL: 'https://agent', AGENT_RU_URL: 'https://other', AGENT_SECRET: 'test' };
const args = { username: 'owner', chatId: 42 };
const response = data => ({ ok: true, json: async () => data });
afterEach(() => vi.unstubAllGlobals());
it('uses basic list when live endpoint falsely returns create with unavailable note', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(response({ action: 'create', choices: [], note: 'projects model unavailable' }))
    .mockResolvedValueOnce(response({ projects: [{ id: 'a' }, { id: 'b' }] }));
  vi.stubGlobal('fetch', fetcher);
  expect(await getProjectDecision(env, args)).toMatchObject({ action: 'ask', choices: [{ id: 'a' }, { id: 'b' }] });
  expect(fetcher.mock.calls[1][0]).toBe('https://agent/projects?username=owner&audience=default');
});
it('fails visibly when both endpoints fail, rather than inventing an empty profile', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
  await expect(getProjectDecision(env, args)).rejects.toThrow('Не удалось загрузить');
});
it('does not request basic list when enriched decision is valid', async () => {
  const fetcher = vi.fn().mockResolvedValue(response({ action: 'auto', choices: [{ id: 'a' }] }));
  vi.stubGlobal('fetch', fetcher);
  expect((await getProjectDecision(env, args)).action).toBe('auto'); expect(fetcher).toHaveBeenCalledTimes(1);
});

// Cross-bot session leak fix: audience scopes project resolution per bot so the
// recruiter bot and default bot don't share each other's active project for the
// same human (backend keys only by username+chatId otherwise).
it('sends audience=default when SESSION_NAMESPACE is not set', async () => {
  const fetcher = vi.fn().mockResolvedValue(response({ action: 'auto', choices: [{ id: 'a' }] }));
  vi.stubGlobal('fetch', fetcher);
  await getProjectDecision(env, args);
  expect(fetcher.mock.calls[0][0]).toContain('audience=default');
});

it('sends audience=recruiter when SESSION_NAMESPACE is "recruiter"', async () => {
  const fetcher = vi.fn().mockResolvedValue(response({ action: 'auto', choices: [{ id: 'a' }] }));
  vi.stubGlobal('fetch', fetcher);
  await getProjectDecision({ ...env, SESSION_NAMESPACE: 'recruiter' }, args);
  expect(fetcher.mock.calls[0][0]).toContain('audience=recruiter');
});
