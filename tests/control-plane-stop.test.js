import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/kv.js', () => ({ getSession: vi.fn() }));
import { getSession } from '../src/lib/kv.js';
import { stopTask } from '../src/lib/agent-client.js';
import { ControlPlaneClient } from '../src/sandbox-tg/control-plane-client.js';

const profileId = 'integration-fixture';
const taskId = 'ut-fixture';
const requestId = `tgcp-${'a'.repeat(64)}`;

function fixture(result = {}) {
  const targets = { snapshotId: 'stop_fixture', profileId, conversationId: 'tg-7-sfixture',
    tasks: [{ userTaskId: taskId, requestId, profileId, receiptId: 'receipt-fixture' }],
    unresolved: false, stopConfirmed: true, ...result };
  const calls = [];
  const doFetch = vi.fn(async (input, init) => {
    const path = new URL(input).pathname;
    calls.push({ path, body: JSON.parse(init.body) });
    if (path === '/stop') return Response.json({ stopped: true, held: 2 });
    if (path === '/cp-stop-targets') return Response.json(targets);
    throw new Error(`unexpected Intake DO route: ${path}`);
  });
  const env = { EXECUTION_BACKEND: 'control-plane', TG_SANDBOX_BOT_USERNAME: 'fixture_isolated_bot', TG_SANDBOX_BOT_TOKEN: 'fixture-token',
    CONTROL_PLANE_URL: 'https://cp.invalid', CONTROL_PLANE_PRINCIPAL: 'fixture-principal', CONTROL_PLANE_PRINCIPAL_SIGNATURE: 'fixture-signature',
    CONTROL_PLANE_PROFILE: profileId, TG_SLICE_ALLOWED_CHATS: '7', SESSIONS: {},
    INTAKE: { idFromName: vi.fn(value => value), get: vi.fn(() => ({ fetch: doFetch })) } };
  return { env, targets, calls, doFetch };
}

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({ username: 'fixture', controlPlaneProfile: profileId });
});

describe('CP-backed Telegram stop', () => {
  it('persists the local hold first and accepts only the CP durable stop confirmation', async () => {
    const current = fixture();
    expect(await stopTask(current.env, { username: 'fixture', chatId: 7 })).toEqual({ killed: 1,
      stopConfirmed: true, status: 'stopped', userTaskIds: [taskId], snapshotId: 'stop_fixture' });
    expect(current.calls.map(call => call.path)).toEqual(['/stop', '/cp-stop-targets']);
    expect(current.calls[0].body).toMatchObject({ username: 'fixture', chatId: 7, threadId: null });
    expect(current.doFetch).toHaveBeenCalledTimes(2);
  });

  it('keeps the durable hold when CP admission or native stop remains unresolved', async () => {
    const current = fixture({ snapshotId: null, tasks: [], unresolved: true,
      stopConfirmed: false, reason: 'admission_unknown' });
    await expect(stopTask(current.env, { username: 'fixture', chatId: 7 }))
      .rejects.toMatchObject({ code: 'CONTROL_PLANE_STOP_PENDING', stopConfirmed: false });
    expect(current.calls.map(call => call.path)).toEqual(['/stop', '/cp-stop-targets']);
  });

  it('refuses mismatched profile, malformed request IDs, and missing receipt identities', async () => {
    for (const change of [
      { profileId: 'foreign-profile' },
      { tasks: [{ userTaskId: taskId, requestId: 'invented', profileId, receiptId: 'receipt-fixture' }] },
      { tasks: [{ userTaskId: taskId, requestId, profileId }] },
    ]) {
      const current = fixture(change);
      await expect(stopTask(current.env, { username: 'fixture', chatId: 7 }))
        .rejects.toMatchObject({ code: 'CONTROL_PLANE_STOP_PENDING' });
    }
  });

  it('sends only generic conversation identity, barrier and admissions to CP', async () => {
    const seen = [];
    const client = new ControlPlaneClient({ controlPlaneUrl: 'https://cp.invalid', principalId: 'fixture-principal',
      principalSignature: 'fixture-signature', profileId, requestTimeoutMs: 1000 }, {
      fetchImpl: async (url, init) => {
        seen.push({ url: new URL(url), init });
        return Response.json({ snapshotId: 'stable', profileId, conversationId: 'conversation-1',
          tasks: [], unresolved: false, stopConfirmed: true });
      },
    });
    const result = await client.stopTargets({ conversationId: 'conversation-1', windowId: 'window-1',
      admissionBarrierComplete: true, admissionRequestIds: [requestId], restart: true });
    expect(result).toMatchObject({ snapshotId: 'stable', stopConfirmed: true, unresolved: false });
    expect(seen[0].url.pathname).toBe('/cp-stop-targets');
    expect(JSON.parse(seen[0].init.body)).toEqual({ profileId, conversationId: 'conversation-1', windowId: 'window-1',
      admissionBarrierComplete: true, admissionRequestIds: [requestId], restart: true });
    expect(JSON.parse(seen[0].init.body)).not.toHaveProperty('chatId');
  });

  it('legacy branch keeps exact agent stop endpoint and chat scope', async () => {
    const transport = vi.fn(async () => Response.json({ killed: 1 }));
    vi.stubGlobal('fetch', transport);
    try {
      const result = await stopTask({ AGENT_URL: 'https://legacy.invalid', AGENT_SECRET: 'fixture-key' }, { username: 'fixture', chatId: 7 });
      expect(result).toEqual({ killed: 1 });
      expect(transport.mock.calls[0][0]).toBe('https://legacy.invalid/tasks/stop');
      expect(JSON.parse(transport.mock.calls[0][1].body)).toMatchObject({ username: 'fixture', chatId: 7 });
    } finally { vi.unstubAllGlobals(); }
  });
});
