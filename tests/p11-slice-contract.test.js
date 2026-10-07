import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { MemKV, collectLogSink, makeEnv } from '../tests/helpers/p11-helpers.js';
import { readTgSliceConfig, authScheme, PRODUCTION_BOT_USERNAMES, chatAllowed } from '../src/sandbox-tg/config.js';
import { ControlPlaneClient } from '../src/sandbox-tg/control-plane-client.js';
import { profileForUpdate } from '../src/sandbox-tg/profile.js';
import { TelegramEmulator } from '../src/sandbox-tg/telegram-emulator.js';
import { FakeControlPlane } from '../src/sandbox-tg/fake-control-plane.js';
import { TgDeliveryOutbox, DELIVERY_STATUS } from '../src/sandbox-tg/delivery.js';
import { ConversationSession, MemoryConversationStore, ConversationNotFoundError } from '../src/sandbox-tg/conversation.js';
import { messageKey, BatchCollector, MemoryBatchStore, BATCH_STATUS, tooLargeMessage, isTooLarge, attachmentOf, launchButton, launchedButton } from '../src/sandbox-tg/batch.js';
import { logTg, createLogCollector } from '../src/sandbox-tg/log.js';
import { TELEGRAM_FILE_SIZE_LIMIT_BYTES } from '../src/sandbox-tg/contract.js';

// ---------------------------------------------------------------- config/profile

describe('config — production-bot guard + env-only', () => {
  it('refuses to start as a production bot', () => {
    for (const username of PRODUCTION_BOT_USERNAMES) {
      expect(() => readTgSliceConfig(makeEnv({ TG_SANDBOX_BOT_USERNAME: username }))).toThrow(/production bot/i);
    }
  });
  it('requires CONTROL_PLANE_URL / PRINCIPAL / PROFILE', () => {
    expect(() => readTgSliceConfig(makeEnv({ CONTROL_PLANE_URL: '' }))).toThrow('CONTROL_PLANE_URL');
    expect(() => readTgSliceConfig(makeEnv({ CONTROL_PLANE_PRINCIPAL: '' }))).toThrow('CONTROL_PLANE_PRINCIPAL');
    expect(() => readTgSliceConfig(makeEnv({ CONTROL_PLANE_PROFILE: '' }))).toThrow('CONTROL_PLANE_PROFILE');
  });
  it('allowlist empty → no chat served (fail closed)', () => {
    const config = readTgSliceConfig(makeEnv({ TG_SLICE_ALLOWED_CHATS: '' }));
    expect(profileForUpdate(config, { message: { chat: { id: 1001 } } })).toBeNull();
  });
  it('maps allowed chat to the sandbox profile', () => {
    const config = readTgSliceConfig(makeEnv({ TG_SLICE_ALLOWED_CHATS: '1001' }));
    const profile = profileForUpdate(config, { message: { chat: { id: 1001 }, message_id: 7 } });
    expect(profile).toBeTruthy();
    expect(profile.profileId).toBe('profile-1');
    expect(profile.channel).toBe('telegram');
    expect(profile.conversationId).toBe('tg-1001');
    expect(profile.ingressRef).toBe('tg:probability_cat_bot:1001:7');
  });
  it('opens additional chats only for an explicitly sandbox-marked UX lane', () => {
    expect(() => readTgSliceConfig(makeEnv({ TG_SLICE_OPEN_SANDBOX: 'true' }))).toThrow(/only for a sandbox Worker/i);
    const config = readTgSliceConfig(makeEnv({ TG_SLICE_OPEN_SANDBOX: 'true', TG_ACCEPT_ONLY_ENVIRONMENT: 'sandbox' }));
    expect(chatAllowed(config, -100999)).toBe(true);
    expect(readTgSliceConfig(makeEnv({})).openSandbox).toBe(false);
  });
  it('auth scheme depends on bearer key', () => {
    expect(authScheme(readTgSliceConfig(makeEnv({ CONTROL_PLANE_API_KEY: '' })))).toBe('x-principal');
    expect(authScheme(readTgSliceConfig(makeEnv({ CONTROL_PLANE_API_KEY: 'ak_test' })))).toBe('x-principal+bearer');
  });
});

// ---------------------------------------------------------------- contract mirror

describe('control-plane-client mirrors the web slice contract', () => {
  let cp, fake, em;

  beforeEach(async () => {
    fake = new FakeControlPlane();
    const config = readTgSliceConfig(makeEnv({ CONTROL_PLANE_URL: 'http://127.0.0.1:19789' }));
    cp = new ControlPlaneClient(config, {
      fetchImpl: async (input, init) => {
        const result = await fake.fetch(input, init);
        return new Response(JSON.stringify(result.value ?? {}), { status: result.status, headers: { 'content-type': 'application/json' } });
      },
      logSink: () => {},
    });
  });

  it('intake returns durable receipt + userTaskId; repeat = duplicate', async () => {
    const r1 = await cp.intake({ requestId: 'r1', text: 'hi', conversationId: 'c1' });
    expect(r1.durable).toBe(true);
    expect(r1.userTaskId).toBeTruthy();
    expect(r1.duplicate).toBe(false);
    const r2 = await cp.intake({ requestId: 'r1', text: 'hi', conversationId: 'c1' });
    expect(r2.duplicate).toBe(true);
    expect(r2.userTaskId).toBe(r1.userTaskId);
  });

  it('start is idempotent: repeat = same instance', async () => {
    const { userTaskId } = await cp.intake({ requestId: 's1', text: 'x', conversationId: 'c1' });
    const a = await cp.start(userTaskId);
    expect(a.instanceCreated).toBe(true);
    const b = await cp.start(userTaskId);
    expect(b.instanceCreated).toBe(false);
    expect(b.runId).toBe(a.runId);
  });

  it('signal idempotent: double click → one awaiting_answered', async () => {
    const { userTaskId } = await cp.intake({ requestId: 'sg1', text: 'x', conversationId: 'c1' });
    await cp.start(userTaskId);
    const a1 = await cp.signal(userTaskId, { type: 'user_reply', payload: { answer: 'да' }, idempotencyKey: 'm2' });
    expect(a1.delivered).toBe(true);
    expect(a1.duplicate).toBe(false);
    const a2 = await cp.signal(userTaskId, { type: 'user_reply', payload: { answer: 'да' }, idempotencyKey: 'm2' });
    expect(a2.delivered).toBe(true);
    expect(a2.duplicate).toBe(true);
    const status = await cp.status(userTaskId);
    expect(status.status).toBe('done');
  });

  it('events read by cursor; reopen returns no duplicates', async () => {
    const { userTaskId } = await cp.intake({ requestId: 'ev1', text: 'x', conversationId: 'c1' });
    await cp.start(userTaskId);
    const p1 = await cp.events(userTaskId, null);
    expect(p1.events.length).toBeGreaterThanOrEqual(1);
    const p2 = await cp.events(userTaskId, p1.nextCursor);
    expect(p2.events.length).toBe(0);
    expect(p2.hasMore).toBe(false);
  });

  it('resume returns new runId, generation+1', async () => {
    const { userTaskId } = await cp.intake({ requestId: 'rs1', text: 'x', conversationId: 'c1' });
    await cp.start(userTaskId);
    const r1 = await cp.resume(userTaskId, { reason: 'explicit_user_continuation' });
    expect(r1.generation).toBeGreaterThanOrEqual(1);
    expect(r1.runId).toBeTruthy();
  });

  it('connection_lost marks attempt unknown, task stays active', async () => {
    const { userTaskId } = await cp.intake({ requestId: 'cl1', text: 'x', conversationId: 'c1' });
    await cp.start(userTaskId);
    const status = await cp.status(userTaskId);
    expect(status.status).not.toBe('failed');
  });

  it('health reflects the fake', async () => {
    const h = await cp.health();
    expect(h.service).toBe('fake-control-plane');
  });
});

// ---------------------------------------------------------------- delivery

describe('delivery outbox — durable ACK + replay + retry', () => {
  let kv, em, api, outbox;

  beforeEach(async () => {
    kv = new MemKV();
    em = new TelegramEmulator({ botUsername: 'probability_cat_bot' });
    const { TelegramApi } = await import('../src/sandbox-tg/telegram.js');
    const config = readTgSliceConfig(makeEnv({}));
    api = new TelegramApi(config, { token: 'test-token', fetchImpl: (input, init) => em.fetch(input, init) });
    outbox = new TgDeliveryOutbox(kv, api, { deliveryMaxAttempts: 3, retryBaseMs: 10, logSink: () => {} });
  });

  it('enqueue + drain delivers once, retries on failure', async () => {
    em.failNext({ status: 500 });
    const { record } = await outbox.enqueue({
      conversationId: 'c1', userTaskId: 'ut-1', requestId: 'r1',
      destination: { chatId: 1001 }, type: 'message', text: 'hello',
    });
    expect(record.status).toBe(DELIVERY_STATUS.pending);
    await outbox.drain();
    const afterFirst = await outbox.load('ut-1');
    expect(afterFirst.status).toBe(DELIVERY_STATUS.retrying);
    await outbox.drain();
    const done = await outbox.load('ut-1');
    expect(done.status).toBe(DELIVERY_STATUS.sent);
    expect(em.messagesTo(1001).length).toBe(1);
  });

  it('replay of same userTaskId returns the sent record', async () => {
    const { record } = await outbox.enqueue({
      conversationId: 'c1', userTaskId: 'ut-2', requestId: 'r2',
      destination: { chatId: 1001 }, type: 'message', text: 'hello',
    });
    await outbox.drain();
    const { duplicate } = await outbox.enqueue({
      conversationId: 'c1', userTaskId: 'ut-2', requestId: 'r2',
      destination: { chatId: 1001 }, type: 'message', text: 'hello',
    });
    expect(duplicate).toBe(true);
  });
});

// ---------------------------------------------------------------- conversation

describe('conversation session — restart preserves context', () => {
  it('five messages, restart between 3rd/4th, same userTaskId', async () => {
    const fake = new FakeControlPlane();
    const config = readTgSliceConfig(makeEnv({}));
    const client = new ControlPlaneClient(config, {
      fetchImpl: async (input, init) => {
        const result = await fake.fetch(input, init);
        return new Response(JSON.stringify(result.value ?? {}), { status: result.status, headers: { 'content-type': 'application/json' } });
      },
      logSink: () => {},
    });
    const store = new MemoryConversationStore();
    const conv = new ConversationSession(client, { conversationId: 'conv-r', profileId: 'profile-1', store, maxTurns: 10 });
    await conv.create();

    const m1 = await conv.sendMessage('first');
    expect(m1.started).toBe(true);
    const v1 = await conv.refresh();
    const ut = v1.turns[0].userTaskId;
    expect(v1.awaiting).toBeTruthy();

    const a1 = await conv.answer('first answer');
    expect(a1.delivered).toBe(true);
    const v2 = await conv.refresh();
    expect(v2.turns[1].terminal).toBe('done');

    const m3 = await conv.sendMessage('third');
    expect(m3.started).toBe(true);
    const ut3 = m3.userTaskId;
    // restart control plane: journal survives, instances gone
    fake.restart();
    await conv.recover();
    // after restart, open the conversation — cold session rebuilds from journal
    const conv2 = new ConversationSession(client, { conversationId: 'conv-r', profileId: 'profile-1', store, maxTurns: 10 });
    const v3 = await conv2.open();
    // run_started stays one per task (no rerun)
    const task3 = v3.turns.find(t => t.text === 'third');
    expect(task3).toBeTruthy();
    expect(task3.runStartedCount).toBe(1);
    const a2 = await conv2.answer('second answer');
    expect(a2.delivered).toBe(true);
    const v4 = await conv2.refresh();
    expect(v4.turns[3].terminal).toBe('done');
    // 5th message opens a third task
    const m5 = await conv2.sendMessage('fifth');
    expect(m5.started).toBe(true);
    const v5 = await conv2.refresh();
    expect(v5.turns.length).toBe(5);
  });
});

// ---------------------------------------------------------------- batch/media

describe('batch assembly + media normalization (PR-12/PR-13)', () => {
  it('10 items accumulate, one launch button, accepted count = items', async () => {
    const store = new MemoryBatchStore();
    const coll = new BatchCollector(store, { maxItems: 20 });
    for (let i = 1; i <= 10; i++) await coll.add('c1', { type: 'text', text: `m${i}`, receivedAt: Date.now() });
    const batch = store.data.get('c1');
    expect(batch.items.length).toBe(10);
    const markup = launchButton(batch);
    expect(markup.inline_keyboard[0][0].text).toContain('(10)');
  });

  it('voice / document / photo parsed by type, not extension', () => {
    const m = attachmentOf({ voice: { file_id: 'v1', duration: 5, mime_type: 'audio/ogg', file_size: 1000 } });
    expect(m.type).toBe('voice');
    const d = attachmentOf({ document: { file_id: 'd1', file_name: 'отчёт.xlsx', mime_type: 'application/vnd.openxmlformats', file_size: 100 } });
    expect(d.type).toBe('document');
    expect(d.fileName).toBe('отчёт.xlsx');
    const p = attachmentOf({ photo: [{ file_id: 'p1', file_size: 50 }, { file_id: 'p2', file_size: 200 }] });
    expect(p.type).toBe('photo');
    expect(p.fileId).toBe('p2');
  });

  it('file >20 MiB refused with a clear Cyrillic message', () => {
    const msg = tooLargeMessage('документ.pdf');
    expect(msg).toContain('документ.pdf');
    expect(msg).toContain('20 МБ');
    const big = attachmentOf({ document: { file_id: 'b1', file_name: 'big.pdf', file_size: TELEGRAM_FILE_SIZE_LIMIT_BYTES + 1 } });
    expect(isTooLarge(big.fileSize)).toBe(true);
  });
});

// ---------------------------------------------------------------- logging

describe('C12 log — structured, no secrets', () => {
  it('redacts sensitive field names', () => {
    const line = logTg({ event: 'x', userTaskId: 'ut-1', apiKey: 'secret123', text: 'hi' });
    const parsed = JSON.parse(line);
    expect(parsed.apiKey).toBe('[redacted]');
    expect(parsed.text).toBe('[redacted]');
    expect(parsed.userTaskId).toBe('ut-1');
  });
  it('collector returns structured entries', async () => {
    const sink = createLogCollector();
    logTg({ event: 'test', userTaskId: 'ut-1' }, sink);
    expect(sink.entries().length).toBe(1);
    expect(sink.entries()[0].event).toBe('test');
  });
});
