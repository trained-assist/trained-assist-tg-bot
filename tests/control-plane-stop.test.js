import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/kv.js', () => ({ getSession: vi.fn() }));
import { getSession } from '../src/lib/kv.js';
import { stopTask } from '../src/lib/agent-client.js';
import { ControlPlaneClient } from '../src/sandbox-tg/control-plane-client.js';

const taskId = 'ut-fixture';
const runId = 'run_00000000-0000-0000-0000-000000000001';
const requestId = `tgcp-${'a'.repeat(64)}`;
const profileId = 'integration-fixture';

function fixture() {
  const targets = { username: 'fixture', chatId: 7, threadId: null, profileId, unresolved: false,
    tasks: [{ userTaskId: taskId, requestId, profileId }] };
  const proof = { taskId, profileId, attemptId: 'attempt-1', runId, ownerGeneration: 1, state: 'cancelled', exitObserved: true };
  const before = { taskStore: { id: taskId, profile_id: profileId, status: 'running', generation: 1 },
    runs: [{ id: 'attempt-1', task_id: taskId, session_id: runId, generation: 1, status: 'running', finished_at: null }] };
  const after = { taskStore: { ...before.taskStore, status: 'cancelled', generation: 2 },
    runs: [{ ...before.runs[0], status: 'cancelled', finished_at: 10 }], nativeStops: [proof] };
  const acknowledgement = { cancelled: true, stopConfirmed: true, status: 'cancelled', generation: 2, nativeStops: [proof] };
  let statusReads = 0;
  const transport = vi.fn(async (input, init) => {
    const path = new URL(input).pathname;
    expect(new Headers(init.headers).get('x-principal')).toBe('fixture-principal');
    expect(new Headers(init.headers).get('x-principal-sig')).toBe('fixture-signature');
    expect(JSON.parse(init.body).taskId).toBe(taskId);
    if (path === '/cancel') return Response.json(acknowledgement);
    if (path === '/status') return Response.json(statusReads++ ? after : before);
    throw new Error('unexpected CP endpoint');
  });
  const doFetch = vi.fn(async (input, init) => {
    expect(input).toBe('https://intake/cp-stop-targets');
    expect(JSON.parse(init.body)).toEqual({ username: 'fixture', chatId: 7, threadId: null });
    return Response.json(targets);
  });
  const env = { EXECUTION_BACKEND: 'control-plane', TG_SANDBOX_BOT_USERNAME: 'fixture_isolated_bot', TG_SANDBOX_BOT_TOKEN: 'fixture-token',
    CONTROL_PLANE_URL: 'https://cp.invalid', CONTROL_PLANE_PRINCIPAL: 'fixture-principal', CONTROL_PLANE_PRINCIPAL_SIGNATURE: 'fixture-signature',
    CONTROL_PLANE_PROFILE: profileId, TG_SLICE_ALLOWED_CHATS: '7', SESSIONS: {}, CONTROL_PLANE_SERVICE: { fetch: transport },
    INTAKE: { idFromName: vi.fn(value => value), get: vi.fn(() => ({ fetch: doFetch })) } };
  return { env, targets, proof, before, after, acknowledgement, transport, doFetch };
}

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({ username: 'fixture', controlPlaneProfile: profileId });
});

describe('CP-backed Telegram stop', () => {
  it('returns confirmed stop only after native evidence and exact CP terminal readback', async () => {
    const { env, transport, doFetch } = fixture();
    expect(await stopTask(env, { username: 'fixture', chatId: 7 })).toEqual({ killed: 1, stopConfirmed: true, status: 'stopped', userTaskIds: [taskId] });
    expect(transport.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(['/status', '/cancel', '/status']);
    expect(doFetch).toHaveBeenCalledTimes(2);
  });

  for (const kind of ['requested_ack', 'pending', 'rejected', 'no_native_evidence', 'exit_unobserved', 'wrong_task', 'wrong_profile', 'wrong_run', 'wrong_attempt', 'wrong_generation']) {
    it(`${kind} refuses restart rather than confirming request acknowledgement`, async () => {
      const current = fixture();
      if (kind === 'requested_ack') Object.assign(current.acknowledgement, { cancelled: false, stopConfirmed: false });
      if (kind === 'pending') current.acknowledgement.status = 'running';
      if (kind === 'rejected') current.acknowledgement.cancelled = false;
      if (kind === 'no_native_evidence') current.acknowledgement.nativeStops = [];
      if (kind === 'exit_unobserved') current.proof.exitObserved = false;
      if (kind === 'wrong_task') current.proof.taskId = 'other-task';
      if (kind === 'wrong_profile') current.proof.profileId = 'other-profile';
      if (kind === 'wrong_run') current.proof.runId = 'other-run';
      if (kind === 'wrong_attempt') current.proof.attemptId = 'other-attempt';
      if (kind === 'wrong_generation') current.proof.ownerGeneration = 2;
      await expect(stopTask(current.env, { username: 'fixture', chatId: 7 })).rejects.toMatchObject({ code: 'CONTROL_PLANE_STOP_PENDING', killed: 0, stopConfirmed: false });
      expect(current.transport.mock.calls.every(([url]) => !/\/(intake|start|resume|route)$/.test(new URL(url).pathname))).toBe(true);
    });
  }

  for (const kind of ['nonterminal', 'missing_proof', 'new_generation', 'wrong_profile', 'unfinished_attempt']) {
    it(`terminal readback ${kind} does not confirm stop`, async () => {
      const current = fixture();
      if (kind === 'nonterminal') current.after.taskStore.status = 'running';
      if (kind === 'missing_proof') current.after.nativeStops = [];
      if (kind === 'new_generation') current.after.taskStore.generation = 3;
      if (kind === 'wrong_profile') current.after.taskStore.profile_id = 'other-profile';
      if (kind === 'unfinished_attempt') current.after.runs[0].finished_at = null;
      await expect(stopTask(current.env, { username: 'fixture', chatId: 7 })).rejects.toMatchObject({ killed: 0 });
    });
  }

  it('lost acknowledgement retry reads persisted terminal evidence without another cancel or replacement', async () => {
    const current = fixture();
    Object.assign(current.before, current.after);
    expect((await stopTask(current.env, { username: 'fixture', chatId: 7 })).stopConfirmed).toBe(true);
    expect(current.transport.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(['/status', '/status']);
  });

  it('already completed native task with persisted exit evidence needs no cancellation request', async () => {
    const current = fixture();
    current.proof.state = 'succeeded';
    current.after.taskStore.status = 'done';
    current.after.runs[0].status = 'success';
    Object.assign(current.before, current.after);
    expect((await stopTask(current.env, { username: 'fixture', chatId: 7 })).stopConfirmed).toBe(true);
    expect(current.transport.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(['/status', '/status']);
  });

  it('unresolved DO identity, wrong scope or no stored tasks refuses before any CP call', async () => {
    for (const change of [{ unresolved: true }, { profileId: 'other' }, { username: 'other' }, { chatId: 8 }, { threadId: 9 }, { tasks: [] }]) {
      const current = fixture();
      Object.assign(current.targets, change);
      await expect(stopTask(current.env, { username: 'fixture', chatId: 7 })).rejects.toMatchObject({ killed: 0 });
      expect(current.transport).not.toHaveBeenCalled();
    }
  });

  it('all task scopes are validated before the first cancel', async () => {
    const current = fixture();
    current.targets.tasks.push({ userTaskId: 'foreign', profileId: 'foreign', requestId: `tgcp-${'b'.repeat(64)}` });
    await expect(stopTask(current.env, { username: 'fixture', chatId: 7 })).rejects.toMatchObject({ killed: 0 });
    expect(current.transport).not.toHaveBeenCalled();
  });

  it('missing native receipt never invents a run identity', async () => {
    const current = fixture();
    current.before.runs[0].session_id = null;
    await expect(stopTask(current.env, { username: 'fixture', chatId: 7 })).rejects.toMatchObject({ killed: 0 });
    expect(current.transport.mock.calls).toHaveLength(1);
  });

  it('malformed unfinished attempt cannot be hidden by an older completed run', async () => {
    const current = fixture();
    current.before.runs.push({ id: 'unknown-new-attempt', task_id: taskId, session_id: null, generation: 2, status: 'unknown' });
    await expect(stopTask(current.env, { username: 'fixture', chatId: 7 })).rejects.toMatchObject({ killed: 0 });
    expect(current.transport.mock.calls).toHaveLength(1);
  });

  it('changed DO target set after readback refuses aggregate confirmation', async () => {
    const current = fixture();
    current.doFetch.mockResolvedValueOnce(Response.json(current.targets));
    current.doFetch.mockResolvedValueOnce(Response.json({ ...current.targets, tasks: [...current.targets.tasks,
      { userTaskId: 'new-task', profileId, requestId: `tgcp-${'b'.repeat(64)}` }] }));
    await expect(stopTask(current.env, { username: 'fixture', chatId: 7 })).rejects.toMatchObject({ killed: 0 });
  });

  it('CP network and cancellation HTTP errors are sanitized and never fall through to legacy', async () => {
    const current = fixture();
    current.transport.mockRejectedValueOnce(new Error('private transport fixture detail'));
    await expect(stopTask(current.env, { username: 'fixture', chatId: 7 })).rejects.toThrow('Остановка нового исполнителя не подтверждена');
  });

  it('legacy branch keeps exact agent stop endpoint and chat/audience scope', async () => {
    const transport = vi.fn(async () => Response.json({ killed: 1 }));
    vi.stubGlobal('fetch', transport);
    try {
      const result = await stopTask({ AGENT_URL: 'https://legacy.invalid', AGENT_SECRET: 'fixture-key' }, { username: 'fixture', chatId: 7 });
      expect(result).toEqual({ killed: 1 });
      expect(transport.mock.calls[0][0]).toBe('https://legacy.invalid/tasks/stop');
      expect(JSON.parse(transport.mock.calls[0][1].body)).toMatchObject({ username: 'fixture', chatId: 7 });
    } finally { vi.unstubAllGlobals(); }
  });

  it('client cancellation uses signed CP transport and preserves unconfirmed semantics', async () => {
    const current = fixture();
    const client = new ControlPlaneClient({ controlPlaneUrl: 'https://cp.invalid', principalId: 'fixture-principal',
      principalSignature: 'fixture-signature', requestTimeoutMs: 1000 }, { fetchImpl: current.transport });
    current.acknowledgement.stopConfirmed = false;
    expect((await client.cancel(taskId)).stopConfirmed).toBe(false);
  });
});
