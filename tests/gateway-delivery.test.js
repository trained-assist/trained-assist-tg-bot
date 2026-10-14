import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendMessage = vi.fn();
const sendMessageWithKeyboard = vi.fn();
const deliveryOwner = vi.hoisted(() => ({
  records: new Map(), enqueue: vi.fn(), drain: vi.fn(), load: vi.fn(),
}));

vi.mock('../src/lib/telegram.js', () => ({
  sendMessage: (...a) => sendMessage(...a),
  sendMessageWithKeyboard: (...a) => sendMessageWithKeyboard(...a),
  ensureCommandsRegisteredOnce: vi.fn(),
  getRegisteredCommands: vi.fn(async () => []),
  serveMedia: vi.fn(),
  transcribeAudio: vi.fn(),
  editMessage: vi.fn(async () => ({ ok: true })),
  editMessageReplyMarkup: vi.fn(async () => ({ ok: true })),
  deleteMessage: vi.fn(async () => ({ ok: true })),
  pinMessage: vi.fn(async () => ({ ok: true })),
  answerCallbackQuery: vi.fn(async () => ({ ok: true })),
  sendDocument: vi.fn(async () => ({ ok: true })),
  readMedia: vi.fn(async () => ''),
}));

vi.mock('../src/handlers/message.js', () => ({
  handleMessage: vi.fn(),
  processDueRetries: vi.fn(async () => {}),
  handleIntakePrepared: vi.fn(),
}));
vi.mock('../src/handlers/commands.js', () => ({
  handleCommand: vi.fn(async () => ({ ok: true })),
  isAdminForwardedCommand: () => false,
  isAdminLocalCommand: () => false,
}));
vi.mock('../src/handlers/callbacks.js', () => ({ handleCallbackQuery: vi.fn(async () => ({})) }));
vi.mock('../src/handlers/user-mgmt.js', () => ({
  handleUserMgmt: vi.fn(async () => ({ ok: true })),
  isUserMgmtCommand: () => false,
}));
vi.mock('../src/lib/telegram-extra.js', () => ({}));
vi.mock('../src/sandbox-tg/delivery-owner.js', () => ({
  TgDeliveryOwner: class {},
  TgDeliveryOwnerV2: class {},
  TgDeliveryOwnerClient: class {
    constructor(env) { this.env = env; }
    async enqueue(input) {
      deliveryOwner.enqueue(input);
      const existing = deliveryOwner.records.get(input.deliveryId);
      if (existing) {
        if (JSON.stringify(existing.input) !== JSON.stringify(input)) throw new Error('delivery_id_payload_conflict');
        return { record: existing, duplicate: true };
      }
      const record = { input, status: 'pending', attempts: 0 };
      deliveryOwner.records.set(input.deliveryId, record);
      return { record, duplicate: false };
    }
    async drain() {
      deliveryOwner.drain();
      const record = [...deliveryOwner.records.values()].find(item => item.status === 'pending');
      if (!record) return 0;
      record.status = 'sending';
      record.attempts += 1;
      try {
        const { input } = record;
        const result = input.replyMarkup
          ? await sendMessageWithKeyboard(this.env.BOT_TOKEN, input.destination.chatId, input.text,
            input.replyMarkup.inline_keyboard, input.destination.threadId ? { message_thread_id: input.destination.threadId } : {})
          : await sendMessage(this.env.BOT_TOKEN, input.destination.chatId, input.text,
            input.destination.threadId ? { message_thread_id: input.destination.threadId } : {});
        if (result?.ok === false) { record.status = 'dead'; record.reason = 'provider_rejected'; }
        else if (Number.isSafeInteger(result?.result?.message_id)) {
          record.status = 'sent'; record.telegramMessageId = result.result.message_id;
        } else record.status = 'unknown';
      } catch { record.status = 'unknown'; }
      return 1;
    }
    async load(deliveryId) { deliveryOwner.load(deliveryId); return deliveryOwner.records.get(deliveryId) ?? null; }
  },
}));

const mod = await import('../src/index.js');
const worker = mod.default;

const AUTH = { Authorization: 'Bearer test-secret' };
const SESSIONS = { get: vi.fn(async () => null), put: vi.fn(async () => {}) };

function env() {
  return {
    BOT_TOKEN: 'bt',
    AGENT_SECRET: 'test-secret',
    BUILD_SHA: 'test-build',
    SESSIONS,
    INTAKE: { idFromName: (n) => n, get: () => ({ fetch: vi.fn(async () => new Response('{}')) }) },
    USERS: SESSIONS,
    TG_DELIVERY_OWNER: { idFromName: n => n, get: () => ({ fetch: vi.fn() }) },
  };
}

const deliver = (body) =>
  worker.fetch(new Request('https://x/deliver', {
    method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ userTaskId: 'ut-test', taskAcceptedAt: Date.now(), ...body }),
  }), env());

beforeEach(() => {
  vi.clearAllMocks();
  SESSIONS.get.mockResolvedValue(null);
  SESSIONS.put.mockResolvedValue(undefined);
  sendMessage.mockResolvedValue({ ok: true, result: { message_id: 555 } });
  sendMessageWithKeyboard.mockResolvedValue({ ok: true, result: { message_id: 556 } });
  deliveryOwner.records.clear();
  deliveryOwner.enqueue.mockClear();
  deliveryOwner.drain.mockClear();
  deliveryOwner.load.mockClear();
});

describe('POST /deliver — реальный адаптер канала (arch#132 П3b)', () => {
  it('без секрета — 401', async () => {
    const res = await worker.fetch(new Request('https://x/deliver', { method: 'POST', body: '{}' }), env());
    expect(res.status).toBe(401);
  });

  it('stuck_input уходит в чат С КНОПКОЙ запуска и возвращает providerMessageId', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await deliver({
      deliveryId: 'd-1', userTaskId: 'ut-delivery-1', channel: 'telegram', destinationId: '-5496844108',
      message: { kind: 'stuck_input', text: '⏳ Всё ещё жду запуска', actions: ['launch'] },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.providerMessageId).toBe(556);
    expect(sendMessageWithKeyboard).toHaveBeenCalledTimes(1);
    // The durable owner receives the Telegram keyboard rows and stable task timestamp.
    const rows = sendMessageWithKeyboard.mock.calls[0][3];
    expect(Array.isArray(rows)).toBe(true);
    expect(JSON.stringify(rows)).toContain('intake_run');
    // Адрес доставки — отрицательный id группы, он не теряется.
    expect(Number(sendMessageWithKeyboard.mock.calls[0][1])).toBe(-5496844108);
    expect(deliveryOwner.enqueue).toHaveBeenCalledWith(expect.objectContaining({ taskAcceptedAt: expect.any(Number), type: 'launch' }));
    const event = JSON.parse(log.mock.calls.map(call => call[0]).find(line => line.includes('tg.delivery.accepted')));
    expect(event).toMatchObject({ deliveryId: 'd-1', taskId: 'ut-delivery-1', status: 'sent', providerMessageId: 556 });
    expect(JSON.stringify(event)).not.toContain('-5496844108');
    expect(JSON.stringify(event)).not.toContain('Всё ещё жду запуска');
    log.mockRestore();
  });

  it('канал не принял сообщение — НЕ доставка: 502 без providerMessageId', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    sendMessageWithKeyboard.mockResolvedValue({ ok: false, description: 'Bad Request: chat not found' });
    const res = await deliver({
      deliveryId: 'd-2', channel: 'telegram', destinationId: '42',
      message: { kind: 'stuck_input', text: '⏳ жду' },
    });
    expect(res.status).toBe(502);
    expect((await res.json()).providerMessageId).toBeUndefined();
    const event = JSON.parse(log.mock.calls.map(call => call[0]).find(line => line.includes('tg.delivery.rejected')));
    expect(event).toMatchObject({ deliveryId: 'd-2', status: 'rejected', reasonCode: 'provider_rejected' });
    expect(JSON.stringify(event)).not.toContain('chat not found');
    log.mockRestore();
  });

  it('неоднозначный ответ канала сохраняется как unknown', async () => {
    sendMessageWithKeyboard.mockRejectedValue(new Error('ambiguous network failure'));
    const res = await deliver({
      deliveryId: 'd-3', channel: 'telegram', destinationId: '42',
      message: { kind: 'stuck_input', text: '⏳ жду' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: 'unknown', status: 'unknown' });
  });

  it('повтор того же deliveryId после потери HTTP-ответа возвращает receipt без второй отправки', async () => {
    const body = { deliveryId: 'd-replay', userTaskId: 'ut-delivery-replay', taskAcceptedAt: 1730000000000,
      channel: 'telegram', destinationId: '42', message: { text: 'notification' } };
    const first = await deliver(body);
    const second = await deliver(body);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ providerMessageId: 555, duplicate: true });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('ambiguous acceptance is persisted as unknown and a retry never resends', async () => {
    const body = { deliveryId: 'd-unknown', userTaskId: 'ut-delivery-unknown', taskAcceptedAt: 1730000000000,
      channel: 'telegram', destinationId: '42', message: { text: 'notification' } };
    sendMessage.mockRejectedValueOnce(new Error('socket closed after request write'));
    const first = await deliver(body);
    const second = await deliver(body);
    expect((await first.json()).outcome).toBe('unknown');
    expect((await second.json()).outcome).toBe('unknown');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('не-Telegram канал и битый адрес — 400, до обращения к Telegram', async () => {
    expect((await deliver({ deliveryId: 'd', channel: 'api', destinationId: '42', message: { text: 'x' } })).status).toBe(400);
    expect((await deliver({ deliveryId: 'd', channel: 'telegram', destinationId: '0', message: { text: 'x' } })).status).toBe(400);
    expect(sendMessageWithKeyboard).not.toHaveBeenCalled();
  });

  it('без текста — 400', async () => {
    expect((await deliver({ deliveryId: 'd', channel: 'telegram', destinationId: '42', message: {} })).status).toBe(400);
  });

  it('доставленное сообщение попадает в sent:-трекер (/clean_up_flood)', async () => {
    await deliver({
      deliveryId: 'd-4', channel: 'telegram', destinationId: '42',
      message: { kind: 'stuck_input', text: '⏳ жду' },
    });
    expect(SESSIONS.put).toHaveBeenCalledWith('sent:42', expect.stringContaining('556'), expect.anything());
  });
});

// ── Контракт стыка C02.1 ─────────────────────────────────────────────────────
// Контр plane считает доставку выполненной ТОЛЬКО по providerMessageId. Тест
// прибивает wire-форму, от которой зависит control plane: если хоть одно поле или
// код ответа разъедутся, seam-тест control plane упадёт — а не прода.
describe('Контракт стыка C02.1 — форма, от которой зависит control plane', () => {
  it('запрос несёт ровно те поля и тот заголовок, которые ждёт адаптер', async () => {
    await deliver({
      deliveryId: 'd-contract', channel: 'telegram', destinationId: '-100500',
      userTaskId: 'ut-1', conversationId: 'conv-1', audienceId: 'aud-1',
      message: { kind: 'stuck_input', text: '⏳ жду', actions: ['launch'] },
    });
    expect(sendMessageWithKeyboard).toHaveBeenCalledTimes(1);
  });

  it('успех — ровно { providerMessageId } в теле, без «ok» вместо него', async () => {
    const res = await deliver({
      deliveryId: 'd', channel: 'telegram', destinationId: '42', message: { text: 'x' },
    });
    const body = await res.json();
    expect(body).toHaveProperty('providerMessageId');
    expect(typeof body.providerMessageId).toBe('number');
  });

  it('отказ канала — 502 и providerMessageId ОТСУТСТВУЕТ (не null, не 0)', async () => {
    sendMessage.mockResolvedValue({ ok: false, description: 'chat not found' });
    const res = await deliver({
      deliveryId: 'd', channel: 'telegram', destinationId: '42', message: { text: 'x' },
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect('providerMessageId' in body).toBe(false);
  });

  it('неверный секрет — 401, и Telegram НЕ вызывается вовсе', async () => {
    const res = await app_fetch_without_secret();
    expect(res.status).toBe(401);
    expect(sendMessageWithKeyboard).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('не-telegram канал отвергается до обращения к Telegram (повтор не поможет)', async () => {
    const res = await deliver({ deliveryId: 'd', channel: 'web', destinationId: '42', message: { text: 'x' } });
    expect(res.status).toBe(400);
    expect(sendMessageWithKeyboard).not.toHaveBeenCalled();
  });
});

async function app_fetch_without_secret() {
  const mod = await import('../src/index.js');
  return mod.default.fetch(
    new Request('https://x/deliver', { method: 'POST', body: '{}' }),
    env(),
  );
}
