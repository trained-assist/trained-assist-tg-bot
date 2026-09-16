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
  expect(fetcher.mock.calls[1][0]).toBe('https://agent/projects?username=owner');
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
