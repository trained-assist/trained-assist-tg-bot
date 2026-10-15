import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/sandbox-tg/index.js';
import { TgDeliveryOwner, TgDeliveryOwnerClient } from '../src/sandbox-tg/delivery-owner.js';
import { TgDeliveryOutbox } from '../src/sandbox-tg/delivery.js';
import { FakeControlPlane } from '../src/sandbox-tg/fake-control-plane.js';
import { makeEnv, MemKV, ownerState, OwnerStorage } from './helpers/p11-helpers.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(overrides = {}) {
  const env = makeEnv({ TG_SLICE: new MemKV(), ...overrides });
  const client = new TgDeliveryOwnerClient(env);
  await client.open();
  const record = { deliveryId: 'terminal:task:g1', userTaskId: 'task', destination: { chatId: 1001, threadId: 7 },
    type: 'message', text: 'private result', taskAcceptedAt: Date.now() };
  await client.enqueue(record);
  const owner = [...env.TG_DELIVERY_OWNER.owners.values()][0];
  return { env, client, record, owner };
}

async function emptyFixture(overrides = {}) {
  const env = makeEnv({ TG_SLICE: new MemKV(), ...overrides });
  const client = new TgDeliveryOwnerClient(env);
  await client.open();
  const owner = [...env.TG_DELIVERY_OWNER.owners.values()][0];
  return { env, client, owner };
}

describe('sandbox durable single delivery owner', () => {
  it('exposes only a length and digest for delivered message text to the sandbox verifier', async () => {
    const { client } = await fixture();
    const result = await client.read('task');
    const terminal = result.terminal;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('private result'));
    const expectedSha256 = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');

    expect(terminal).toMatchObject({ textCharacterCount: 'private result'.length, textSha256: expectedSha256 });
    expect(terminal).not.toHaveProperty('text');
  });

  it('downloads a task-scoped artifact, verifies size and digest, then sends it as a Telegram document', async () => {
    const { client } = await emptyFixture();
    const bytes = new TextEncoder().encode('E2E-DOC');
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map(value => value.toString(16).padStart(2, '0')).join('');
    const artifact = { ref: 'runs/task/artifact-123', name: 'agent-note.md', sizeBytes: bytes.length,
      sha256, contentType: 'text/markdown' };
    const deliveryId = 'artifact:fixturehash:g1';
    await client.enqueue({ deliveryId, userTaskId: 'task', conversationId: 'conv-1', destination: { chatId: 1001, threadId: 7 },
      type: 'artifact', text: '', artifact, taskAcceptedAt: Date.now() });
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const url = new URL(input);
      requests.push({ url, init });
      if (url.pathname === '/artifact') return new Response(bytes, { status: 200, headers: {
        'content-type': 'text/markdown', 'content-length': String(bytes.length),
        'content-disposition': 'attachment; filename="agent-note.md"; filename*=UTF-8\'\'agent-note.md',
        'x-artifact-sha256': sha256, 'x-artifact-id': 'artifact-123',
      } });
      if (url.pathname.endsWith('/sendDocument')) return Response.json({ ok: true, result: { message_id: 2026 } });
      throw new Error('unexpected_request');
    }));

    expect(await client.drain()).toBe(1);
    const receipt = await client.load(deliveryId);
    expect(receipt).toMatchObject({ status: 'sent', telegramMessageId: 2026, artifact: { name: 'agent-note.md' } });
    expect(requests).toHaveLength(2);
    const [download, send] = requests;
    expect(download.url.pathname).toBe('/artifact');
    expect(download.url.searchParams.get('taskId')).toBe('task');
    expect(download.url.searchParams.get('ref')).toBe('runs/task/artifact-123');
    expect(download.init.headers.get('x-principal')).toBe('sandbox-local');
    expect(send.url.pathname.endsWith('/sendDocument')).toBe(true);
    expect(send.init.body.get('chat_id')).toBe('1001');
    expect(send.init.body.get('message_thread_id')).toBe('7');
    const uploaded = send.init.body.get('document');
    expect(uploaded.name).toBe('agent-note.md');
    expect(new TextDecoder().decode(await uploaded.arrayBuffer())).toBe('E2E-DOC');
    expect(await client.read('task', { includeArtifacts: true })).toMatchObject({ artifacts: [{
      deliveryId, status: 'sent', providerMessageId: 2026, type: 'artifact', artifactName: 'agent-note.md', chatId: 1001, threadId: 7,
    }] });
  });

  it('refuses an artifact with a checksum mismatch and rejects a duplicate sent to another destination', async () => {
    const { client } = await emptyFixture();
    const bytes = new TextEncoder().encode('wrong bytes');
    const artifact = { ref: 'artifact-456', name: 'agent-note.md', sizeBytes: 11, sha256: 'a'.repeat(64), contentType: 'text/markdown' };
    const deliveryId = 'artifact:otherhash:g1';
    const record = { deliveryId, userTaskId: 'task', conversationId: 'conv-1', destination: { chatId: 1001, threadId: 7 },
      type: 'artifact', text: '', artifact, taskAcceptedAt: Date.now() };
    await client.enqueue(record);
    await expect(client.enqueue({ ...record, destination: { chatId: 1002, threadId: 7 } })).rejects.toThrow();
    const sendDocument = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async input => {
      const url = new URL(input);
      if (url.pathname === '/artifact') return new Response(bytes, { status: 200, headers: {
        'content-type': 'text/markdown', 'content-length': String(bytes.length),
        'content-disposition': 'attachment; filename="agent-note.md"',
        'x-artifact-sha256': 'b'.repeat(64), 'x-artifact-id': 'artifact-456',
      } });
      if (url.pathname.endsWith('/sendDocument')) { sendDocument(); return Response.json({ ok: true, result: { message_id: 2027 } }); }
      throw new Error('unexpected_request');
    }));
    expect(await client.drain()).toBe(1);
    expect(await client.load(deliveryId)).toMatchObject({ status: 'dead', reason: 'artifact_integrity_rejected' });
    expect(sendDocument).not.toHaveBeenCalled();
  });

  it('reports only the normalized CP status for a retryable artifact source failure', async () => {
    const { client } = await emptyFixture();
    await client.enqueue({ deliveryId: 'artifact:source-fail:g1', userTaskId: 'task', destination: { chatId: 1001 },
      type: 'artifact', text: '', taskAcceptedAt: Date.now(), artifact: { ref: 'runs/task/output.md', name: 'note.md',
        sizeBytes: 1, sha256: 'a'.repeat(64), contentType: 'text/markdown' } });
    vi.stubGlobal('fetch', async () => new Response('unavailable', { status: 503 }));
    expect(await client.drain()).toBe(1);
    expect((await client.read('task', { includeArtifacts: true })).artifacts).toMatchObject([{
      status: 'retrying', reason: 'artifact_source_unavailable', artifactSourceFailure: 'http_503',
    }]);
  });

  it('extracts only Runner HTTP status from the CP artifact proxy error', async () => {
    const { client } = await emptyFixture();
    await client.enqueue({ deliveryId: 'artifact:runner-fail:g1', userTaskId: 'task', destination: { chatId: 1001 },
      type: 'artifact', text: '', taskAcceptedAt: Date.now(), artifact: { ref: 'runs/task/output.md', name: 'note.md',
        sizeBytes: 1, sha256: 'a'.repeat(64), contentType: 'text/markdown' } });
    vi.stubGlobal('fetch', async () => Response.json({ error: 'artifact unavailable',
      reason: 'artifact private-object-ref: HTTP_404: raw upstream detail' }, { status: 502 }));
    expect(await client.drain()).toBe(1);
    const [record] = (await client.read('task', { includeArtifacts: true })).artifacts;
    expect(record).toMatchObject({ status: 'retrying', reason: 'artifact_source_unavailable', artifactSourceFailure: 'runner_http_404' });
    expect(JSON.stringify(record)).not.toContain('private-object-ref');
    expect(JSON.stringify(record)).not.toContain('raw upstream detail');
  });

  it('rejects traversal segments in artifact object references', async () => {
    const { client } = await emptyFixture();
    await expect(client.enqueue({ deliveryId: 'artifact:unsafe:g1', userTaskId: 'task', destination: { chatId: 1001 },
      type: 'artifact', text: '', taskAcceptedAt: Date.now(), artifact: { ref: 'runs/../private.md', name: 'note.md',
        sizeBytes: 1, sha256: 'a'.repeat(64), contentType: 'text/markdown' } })).rejects.toThrow('delivery_owner_refused');
    expect((await client.read('task', { includeArtifacts: true })).artifacts).toEqual([]);
  });

  it('uses the current Worker pause flags even when the existing Durable Object has stale env', async () => {
    const { env, client } = await fixture();
    const calls = vi.fn(async () => Response.json({ ok: true, result: { message_id: 1365 } }));
    vi.stubGlobal('fetch', calls);

    const pausedClient = new TgDeliveryOwnerClient({ ...env,
      TG_SLICE_DELIVERY_PAUSED: 'true', TG_SLICE_INGRESS_PAUSED: 'true' });
    expect(await pausedClient.open()).toMatchObject({ paused: true, ingressPaused: true });
    expect(await pausedClient.drain()).toBe(0);
    expect(calls).not.toHaveBeenCalled();

    const liveClient = new TgDeliveryOwnerClient({ ...env,
      TG_SLICE_DELIVERY_PAUSED: 'false', TG_SLICE_INGRESS_PAUSED: 'false' });
    expect(await liveClient.open()).toMatchObject({ paused: false, ingressPaused: false });
    expect(await liveClient.drain()).toBe(1);
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it('reproduces original two-drain duplicate even with strong memory KV and stored attempt one', async () => {
    const kv = new MemKV();
    const release = deferred();
    let calls = 0;
    const api = { async sendMessage() {
      calls += 1;
      const message_id = calls;
      if (calls === 2) release.resolve();
      await release.promise;
      return { message_id };
    } };
    const outbox = new TgDeliveryOutbox(kv, api, { logSink: () => {} });
    await outbox.enqueue({ deliveryId: 'terminal:original:g1', userTaskId: 'original', type: 'message', destination: { chatId: 1001 }, text: 'synthetic' });
    await Promise.all([outbox.drain(), outbox.drain()]);
    expect(calls).toBe(2);
    expect((await outbox.load('terminal:original:g1')).attempts).toBe(1);
  });
  it('two drains use one durable sending claim and stable provider ID', async () => {
    const { client, owner } = await fixture();
    const entered = deferred();
    const release = deferred();
    const send = vi.fn(async () => {
      expect((await owner.state.storage.get('delivery:terminal:task:g1')).status).toBe('sending');
      entered.resolve();
      await release.promise;
      return Response.json({ ok: true, result: { message_id: 1365 } });
    });
    vi.stubGlobal('fetch', send);
    const first = client.drain();
    await entered.promise;
    expect((await client.read('task')).terminal).toMatchObject({ status: 'sending', providerMessageId: null, reason: 'provider_outcome_not_recorded' });
    expect((await client.enqueue({ deliveryId: 'terminal:task:g1', userTaskId: 'task', destination: { chatId: 1001, threadId: 7 }, type: 'message', text: 'private result', taskAcceptedAt: (await client.load('terminal:task:g1')).taskAcceptedAt })).duplicate).toBe(true);
    const second = client.drain();
    release.resolve();
    expect(await Promise.all([first, second])).toEqual([1, 0]);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await client.read('task')).terminal.providerMessageId).toBe(1365);
    expect(await client.drain()).toBe(0);
  });

  it('scheduled cron vs manual cron shares the owner and ignores stale KV sent/pending copies', async () => {
    const { client, env } = await fixture();
    const send = vi.fn(async () => Response.json({ ok: true, result: { message_id: 1365 } }));
    vi.stubGlobal('fetch', send);
    await env.TG_SLICE.put('delivery:terminal:task:g1', JSON.stringify({ status: 'pending', telegramMessageId: 9999 }));
    await Promise.all([worker.scheduled({}, env), worker.fetch(new Request('https://sandbox.test/cron', {
      headers: { 'x-telegram-bot-api-secret-token': env.TELEGRAM_WEBHOOK_SECRET },
    }), env)]);
    expect(send).toHaveBeenCalledTimes(1);
    const response = await worker.fetch(new Request('https://sandbox.test/deliveries/task', {
      headers: { 'x-telegram-bot-api-secret-token': env.TELEGRAM_WEBHOOK_SECRET },
    }), env);
    expect((await response.json()).terminal.providerMessageId).toBe(1365);
    expect((await client.load('terminal:task:g1')).status).toBe('sent');
  });

  it('delayed ACK persistence cannot allow a second dispatch', async () => {
    const { client, owner } = await fixture();
    const entered = deferred();
    const release = deferred();
    const put = owner.state.storage.put.bind(owner.state.storage);
    vi.spyOn(owner.state.storage, 'put').mockImplementation(async (name, record) => {
      if (record.status === 'sent') { entered.resolve(); await release.promise; }
      return put(name, record);
    });
    const send = vi.fn(async () => Response.json({ ok: true, result: { message_id: 44 } }));
    vi.stubGlobal('fetch', send);
    const first = client.drain();
    await entered.promise;
    const second = client.drain();
    release.resolve();
    await Promise.all([first, second]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('durable claims prevent duplicates even with independent instance send queues', async () => {
    const { client, owner, env } = await fixture();
    const other = new TgDeliveryOwner(ownerState(owner.state.storage), env);
    await other.ready;
    const entered = deferred();
    const release = deferred();
    const send = vi.fn(async () => {
      entered.resolve();
      await release.promise;
      return Response.json({ ok: true, result: { message_id: 77 } });
    });
    vi.stubGlobal('fetch', send);
    const first = client.drain();
    await entered.promise;
    const second = await other.fetch(new Request('https://delivery-owner.internal/drain', { method: 'POST', body: '{}' }));
    expect((await second.json()).drained).toBe(0);
    expect((await client.read('task')).terminal.status).toBe('sending');
    release.resolve();
    await first;
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(['transport', '500', 'malformed', 'missing_id'])('ambiguous %s outcome becomes unknown and never resends', async mode => {
    const { client } = await fixture();
    const send = vi.fn(async () => {
      if (mode === 'transport') throw new Error('private-token-must-not-leak');
      if (mode === '500') return Response.json({ ok: false, error_code: 500 }, { status: 500 });
      if (mode === 'malformed') return new Response('malformed');
      return Response.json({ ok: true, result: {} });
    });
    vi.stubGlobal('fetch', send);
    await client.drain();
    expect((await client.load('terminal:task:g1')).status).toBe('unknown');
    expect(await client.drain()).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await client.read('task'))).not.toContain('private-token');
  });

  it('success then lost durable ACK stays sending; restart quarantines it as unknown', async () => {
    const { client, owner, env } = await fixture();
    const send = vi.fn(async () => Response.json({ ok: true, result: { message_id: 44 } }));
    vi.stubGlobal('fetch', send);
    vi.spyOn(owner.state.storage, 'put').mockRejectedValue(new Error('storage unavailable'));
    await expect(client.drain()).rejects.toThrow('delivery_owner_refused');
    expect((await owner.state.storage.get('delivery:terminal:task:g1')).status).toBe('sending');
    const restarted = new TgDeliveryOwner(ownerState(owner.state.storage), env);
    await restarted.ready;
    expect((await owner.state.storage.get('delivery:terminal:task:g1')).status).toBe('unknown');
    expect((await restarted.fetch(new Request('https://delivery-owner.internal/drain', { method: 'POST', body: '{}' }))).status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('explicit 429 rejection retries only after bounded delay and reaches its cap', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(10000);
    const { client } = await fixture({ TG_SLICE_DELIVERY_MAX_ATTEMPTS: '2' });
    const send = vi.fn(async () => Response.json({ ok: false, error_code: 429, parameters: { retry_after: 1 } }, { status: 429 }));
    vi.stubGlobal('fetch', send);
    await client.drain();
    expect((await client.load('terminal:task:g1')).status).toBe('retrying');
    expect(await client.drain()).toBe(0);
    Date.now.mockReturnValue(11000);
    await client.drain();
    expect((await client.load('terminal:task:g1')).status).toBe('dead');
    expect(await client.drain()).toBe(0);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('HTTP429 without explicit JSON rejection remains unknown', async () => {
    const { client } = await fixture();
    const send = vi.fn(async () => new Response('rate limited', { status: 429 }));
    vi.stubGlobal('fetch', send);
    await client.drain();
    expect((await client.load('terminal:task:g1')).status).toBe('unknown');
    expect(await client.drain()).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('pre-cutover/missing-time tasks quarantine without reading or draining old KV', async () => {
    const { client, env, record } = await fixture();
    const get = vi.spyOn(env.TG_SLICE, 'get');
    const old = { ...record, deliveryId: 'terminal:old:g1', userTaskId: 'old', taskAcceptedAt: 1 };
    expect((await client.enqueue(old)).record.status).toBe('quarantined');
    expect((await client.enqueue({ ...old, deliveryId: 'terminal:unproven:g1', taskAcceptedAt: undefined })).record.status).toBe('quarantined');
    expect(get).not.toHaveBeenCalled();
  });

  it('same-key payload conflict refuses while exact replay preserves sent ID', async () => {
    const { client, record } = await fixture();
    vi.stubGlobal('fetch', async () => Response.json({ ok: true, result: { message_id: 77 } }));
    await client.drain();
    expect((await client.enqueue(record)).duplicate).toBe(true);
    await expect(client.enqueue({ ...record, text: 'different' })).rejects.toThrow();
    expect((await client.read('task')).terminal.providerMessageId).toBe(77);
  });

  it('pause and missing owner binding fail closed without provider calls', async () => {
    const { client } = await fixture({ TG_SLICE_DELIVERY_PAUSED: 'true' });
    const send = vi.fn(); vi.stubGlobal('fetch', send);
    expect(await client.drain()).toBe(0);
    expect(send).not.toHaveBeenCalled();
    const env = makeEnv({ TG_DELIVERY_OWNER: {} });
    expect(() => new TgDeliveryOwnerClient(env)).toThrow('durable delivery owner required');
  });

  it('recovery is durable across fresh owner instances', async () => {
    const storage = new OwnerStorage();
    const env = makeEnv();
    await new TgDeliveryOwner(ownerState(storage), env).ready;
    await storage.put('delivery:terminal:task:g1', { status: 'sending' });
    const owner = new TgDeliveryOwner(ownerState(storage), env);
    await owner.ready;
    expect((await storage.get('delivery:terminal:task:g1')).status).toBe('unknown');
  });

  it('explicit manifest tombstones every old task despite empty or stale KV and newer turn timestamps', async () => {
    const env = makeEnv({ TG_SLICE: new MemKV() });
    const manifest = JSON.parse(env.TG_SLICE_DELIVERY_CUTOVER_MANIFEST);
    manifest.oldTaskIds = ['old'];
    manifest.deliveries = [{ deliveryId: 'terminal:old:g1', userTaskId: 'old', destination: { chatId: 1001, threadId: null }, priorStatus: 'sent', providerMessageId: 1365, attempts: 1,
      history: [{ at: 1, status: 0 }], observedProviderMessageIds: [1365, 1366] }];
    env.TG_SLICE_DELIVERY_CUTOVER_MANIFEST = JSON.stringify(manifest);
    const client = new TgDeliveryOwnerClient(env);
    const proof = await client.open();
    expect(proof).toMatchObject({ ready: true, quarantinedTaskCount: 1, quarantinedDeliveryCount: 1 });
    expect(proof.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect((await client.read('old')).terminal).toMatchObject({ status: 'quarantined', legacyStatus: 'sent', providerMessageId: 1365 });
    expect(await client.load('terminal:old:g1')).toMatchObject({ legacyHistory: [{ at: 1, status: 0 }], observedProviderMessageIds: [1365, 1366] });
    const result = await client.enqueue({ deliveryId: 'terminal:old:g2', userTaskId: 'old', destination: { chatId: 1001 }, type: 'message', text: 'old task, new index', taskAcceptedAt: Date.now() });
    expect(result.record.status).toBe('quarantined');
    const send = vi.fn(); vi.stubGlobal('fetch', send);
    expect(await client.drain()).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(env.TG_SLICE.data.size).toBe(0);
  });

  it('missing manifest fails closed before task admission even if the owner binding exists', async () => {
    const env = makeEnv({ TG_SLICE: new MemKV(), TG_SLICE_DELIVERY_CUTOVER_MANIFEST: undefined });
    const send = vi.fn(); vi.stubGlobal('fetch', send);
    const response = await worker.fetch(new Request('https://sandbox.test/webhook', { method: 'POST', headers: {
      'x-telegram-bot-api-secret-token': env.TELEGRAM_WEBHOOK_SECRET, 'content-type': 'application/json',
    }, body: JSON.stringify({ update_id: 1, message: { chat: { id: 1001 }, text: 'new' } }) }), env);
    expect(response.status).toBe(503);
    expect(send).not.toHaveBeenCalled();
    expect(env.TG_SLICE.data.size).toBe(0);
  });

  it.each([undefined, null, '12345', 'invalid', 1.5, 0])('receipt acceptedAt=%s cannot acquire provider delivery eligibility', async acceptedAt => {
    const env = makeEnv({ TG_SLICE: new MemKV(), TG_SLICE_ROUTER_ENABLED: 'true' });
    const fake = new FakeControlPlane();
    let providerCalls = 0;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('fetch', async (input, init) => {
      const url = new URL(input);
      if (url.origin === env.TELEGRAM_API_BASE) { providerCalls += 1; throw new Error('unexpected provider'); }
      if (url.pathname === '/route') {
        fake.tasks[0].status = 'done'; fake.tasks[0].generation = 1; fake.tasks[0].result = { answer: 'synthetic quick answer' };
        return Response.json({ route: 'deterministic', execution: { agentStarted: false } });
      }
      const response = await fake.fetch(input, init);
      if (url.pathname === '/intake') response.value.acceptedAt = acceptedAt;
      return Response.json(response.value, { status: response.status });
    });
    const response = await worker.fetch(new Request('https://sandbox.test/webhook', { method: 'POST', headers: {
      'x-telegram-bot-api-secret-token': env.TELEGRAM_WEBHOOK_SECRET, 'content-type': 'application/json',
    }, body: JSON.stringify({ update_id: 1, message: { message_id: 1, chat: { id: 1001 }, text: 'new' } }) }), env);
    expect(response.status).toBe(200);
    const receipt = await response.json();
    await worker.scheduled({}, env);
    await worker.scheduled({}, env);
    const evidence = await new TgDeliveryOwnerClient(env).read(receipt.userTaskId);
    expect(evidence.receipt.status).toBe('quarantined');
    expect(evidence.terminal.status).toBe('quarantined');
    expect(providerCalls).toBe(0);
    const index = JSON.parse(await env.TG_SLICE.get('conv:tg-1001'));
    expect(index.turns[0].providerAcceptedAt).toBeNull();
  });

  it('manifest changes cannot extend an initialized owner and do not overwrite its marker', async () => {
    const { env, client, owner } = await fixture();
    const marker = await owner.state.storage.get('cutover');
    const changed = JSON.parse(env.TG_SLICE_DELIVERY_CUTOVER_MANIFEST);
    changed.oldTaskIds = ['different-old'];
    env.TG_SLICE_DELIVERY_CUTOVER_MANIFEST = JSON.stringify(changed);
    await expect(client.open()).rejects.toThrow('delivery_owner_refused');
    const restarted = new TgDeliveryOwner(ownerState(owner.state.storage), env);
    await expect(restarted.ready).rejects.toThrow('cutover_manifest_conflict');
    expect(await owner.state.storage.get('cutover')).toEqual(marker);
  });

  it('cutover installation is atomic and rejects unmarked prior owner records', async () => {
    const storage = new OwnerStorage();
    await storage.put('delivery:unmarked', { status: 'sending' });
    const owner = new TgDeliveryOwner(ownerState(storage), makeEnv());
    await expect(owner.ready).rejects.toThrow('unmarked_owner_records');
    expect(await storage.get('cutover')).toBeUndefined();
    expect((await storage.get('delivery:unmarked')).status).toBe('sending');
  });

  it('cutover marker is not published if a quarantine record cannot persist', async () => {
    const env = makeEnv();
    const manifest = JSON.parse(env.TG_SLICE_DELIVERY_CUTOVER_MANIFEST);
    manifest.oldTaskIds = ['old'];
    manifest.deliveries = [{ deliveryId: 'terminal:old:g1', userTaskId: 'old', destination: { chatId: 1001, threadId: null }, priorStatus: 'unknown', providerMessageId: null, attempts: 1 }];
    env.TG_SLICE_DELIVERY_CUTOVER_MANIFEST = JSON.stringify(manifest);
    const storage = new OwnerStorage();
    const transaction = storage.transaction.bind(storage);
    vi.spyOn(storage, 'transaction').mockImplementation(callback => transaction(async temporary => {
      const put = temporary.put.bind(temporary);
      temporary.put = async (name, value) => {
        if (name.startsWith('delivery:')) throw new Error('synthetic cutover failure');
        return put(name, value);
      };
      return callback(temporary);
    }));
    const owner = new TgDeliveryOwner(ownerState(storage), env);
    await expect(owner.ready).rejects.toThrow('synthetic cutover failure');
    expect(storage.data.size).toBe(0);
  });
});

describe('complete multipart reply ownership', () => {
  it('acknowledges only all parts, preserves paragraphs, and replay never resends acknowledged text', async () => {
    const { client } = await emptyFixture();
    const text = ['First paragraph. '.repeat(65), 'Second paragraph. '.repeat(65), 'Last paragraph. '.repeat(65)].join('\n\n');
    const record = { deliveryId: 'terminal:long:g1', userTaskId: 'long', destination: { chatId: 1001 },
      type: 'message', text, taskAcceptedAt: Date.now(), replyMarkup: { inline_keyboard: [[{ text: 'Done', callback_data: 'done' }]] } };
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);requests.push(body);
      return Response.json({ ok: true, result: { message_id: 100 + requests.length } });
    }));
    const admitted = await client.enqueue(record);
    expect(admitted.record.partCount).toBeGreaterThan(1);
    await client.drain();
    expect(await client.load(record.deliveryId)).toMatchObject({ status: 'pending', nextPart: 1 });
    expect(requests[0].reply_markup).toBeUndefined();
    expect((await client.enqueue(record)).duplicate).toBe(true);
    for (let i = 1; i < admitted.record.partCount; i++) await client.drain();
    expect(await client.load(record.deliveryId)).toMatchObject({ status: 'sent', nextPart: admitted.record.partCount });
    expect(requests.map(body => body.text).join('')).toBe(text);
    expect(requests.every(body => body.text.length <= 2000)).toBe(true);
    expect(requests.at(-1).reply_markup).toEqual(record.replyMarkup);
    await client.enqueue(record);expect(await client.drain()).toBe(0);
    const report = (await client.read('long')).terminal;
    expect(report).toMatchObject({ status: 'sent', partCount: requests.length, sentParts: requests.length, textCharacterCount: text.length });
    expect(report.providerMessageIds).toHaveLength(requests.length);
    expect(report.textSha256).toHaveLength(64);
    expect(report).not.toHaveProperty('text');
  });

  it('retries an explicitly rejected part without repeating confirmed parts', async () => {
    const { client } = await emptyFixture({ TG_SLICE_DELIVERY_RETRY_BASE_MS: '100' });
    const record = { deliveryId: 'terminal:rate:g1', userTaskId: 'rate', destination: { chatId: 1001 },
      type: 'message', text: ['A','B','C','D','E'].map(letter => letter.repeat(1500)).join('\n\n'), taskAcceptedAt: Date.now() };
    const requests = [];
    let reject = true;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);requests.push(body.text);
      if (requests.length === 4 && reject) { reject = false;return Response.json({ ok: false, error_code: 429, parameters: { retry_after: 1 } }, { status: 429 }); }
      return Response.json({ ok: true, result: { message_id: requests.length + 200 } });
    }));
    await client.enqueue(record);for (let i = 0; i < 4; i++) await client.drain();
    expect(await client.load(record.deliveryId)).toMatchObject({ status: 'retrying', nextPart: 3 });
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000);
    await client.drain();await client.drain();
    expect(await client.load(record.deliveryId)).toMatchObject({ status: 'sent', nextPart: 5 });
    expect(requests[3]).toBe(requests[4]);
    expect(requests.filter(text => text.startsWith('A'))).toHaveLength(1);
  });

  it('fences an ambiguous middle-part send across owner restart', async () => {
    const { client, env, owner } = await emptyFixture();
    const record = { deliveryId: 'terminal:unknown-part:g1', userTaskId: 'unknown-part', destination: { chatId: 1001 },
      type: 'message', text: ['A'.repeat(1500), 'B'.repeat(1500), 'C'.repeat(1500)].join('\n\n'), taskAcceptedAt: Date.now() };
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => { calls++; if (calls === 2) throw new Error('network response lost');return Response.json({ ok: true, result: { message_id: 301 } }); }));
    await client.enqueue(record);await client.drain();await client.drain();
    expect(await client.load(record.deliveryId)).toMatchObject({ status: 'unknown', nextPart: 1, telegramMessageIds: [301] });
    const recovered = new TgDeliveryOwner(ownerState(owner.state.storage), env);
    await recovered.ready;
    expect(await recovered.drain((await import('../src/sandbox-tg/config.js')).readTgSliceConfig(env))).toBe(0);
    expect(calls).toBe(2);
  });
});


it('replays a legacy confirmed 2001..4096-character record without resending or re-splitting it', async () => {
  const { client, owner } = await emptyFixture();
  const record = { deliveryId: 'terminal:legacy:g1', userTaskId: 'legacy', conversationId: null,
    destination: { chatId: 1001, threadId: null }, requestId: 'terminal:legacy:g1', type: 'message',
    text: 'legacy '.repeat(400), replyMarkup: null, taskAcceptedAt: Date.now() };
  await owner.state.storage.put(`delivery:${record.deliveryId}`, { ...record, fingerprint: JSON.stringify(record),
    status: 'sent', attempts: 1, telegramMessageId: 401, createdAt: Date.now() });
  const fetcher = vi.fn();vi.stubGlobal('fetch', fetcher);
  expect((await client.enqueue(record)).duplicate).toBe(true);
  expect(await client.drain()).toBe(0);
  expect(await client.load(record.deliveryId)).toMatchObject({ status: 'sent', telegramMessageId: 401 });
  expect(fetcher).not.toHaveBeenCalled();
});
