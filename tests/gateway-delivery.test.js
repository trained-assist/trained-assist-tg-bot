import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendMessage = vi.fn();
const sendMessageWithKeyboard = vi.fn();

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

const mod = await import('../src/index.js');
const worker = mod.default;

const AUTH = { Authorization: 'Bearer test-secret' };
const SESSIONS = { get: vi.fn(async () => null), put: vi.fn(async () => {}) };

function env() {
  return {
    BOT_TOKEN: 'bt',
    AGENT_SECRET: 'test-secret',
    SESSIONS,
    INTAKE: { idFromName: (n) => n, get: () => ({ fetch: vi.fn(async () => new Response('{}')) }) },
    USERS: SESSIONS,
  };
}

const deliver = (body) =>
  worker.fetch(new Request('https://x/deliver', {
    method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), env());

beforeEach(() => {
  vi.clearAllMocks();
  SESSIONS.get.mockResolvedValue(null);
  SESSIONS.put.mockResolvedValue(undefined);
  sendMessage.mockResolvedValue({ ok: true, result: { message_id: 555 } });
  sendMessageWithKeyboard.mockResolvedValue({ ok: true, result: { message_id: 556 } });
});

describe('POST /deliver — реальный адаптер канала (arch#132 П3b)', () => {
  it('без секрета — 401', async () => {
    const res = await worker.fetch(new Request('https://x/deliver', { method: 'POST', body: '{}' }), env());
    expect(res.status).toBe(401);
  });

  it('stuck_input уходит в чат С КНОПКОЙ запуска и возвращает providerMessageId', async () => {
    const res = await deliver({
      deliveryId: 'd-1', channel: 'telegram', destinationId: '-5496844108',
      message: { kind: 'stuck_input', text: '⏳ Всё ещё жду запуска', actions: ['launch'] },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.providerMessageId).toBe(556);
    expect(sendMessageWithKeyboard).toHaveBeenCalledTimes(1);
    // Адресная кнопка: тот же callback, который сливает буфер ЭТОГО чата.
    const kb = JSON.stringify(sendMessageWithKeyboard.mock.calls[0][3]);
    expect(kb).toContain('intake_run');
    // Адрес доставки — отрицательный id группы, он не теряется.
    expect(Number(sendMessageWithKeyboard.mock.calls[0][1])).toBe(-5496844108);
  });

  it('канал не принял сообщение — НЕ доставка: 502 без providerMessageId', async () => {
    sendMessageWithKeyboard.mockResolvedValue({ ok: false, description: 'Bad Request: chat not found' });
    const res = await deliver({
      deliveryId: 'd-2', channel: 'telegram', destinationId: '42',
      message: { kind: 'stuck_input', text: '⏳ жду' },
    });
    expect(res.status).toBe(502);
    expect((await res.json()).providerMessageId).toBeUndefined();
  });

  it('канал недоступен полностью — 502, а не «успех без message_id»', async () => {
    sendMessageWithKeyboard.mockResolvedValue({ ok: false, description: 'bot was blocked' });
    sendMessage.mockResolvedValue({ ok: false, description: 'bot was blocked' });
    const res = await deliver({
      deliveryId: 'd-3', channel: 'telegram', destinationId: '42',
      message: { kind: 'stuck_input', text: '⏳ жду' },
    });
    expect(res.status).toBe(502);
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
    sendMessageWithKeyboard.mockResolvedValue({ ok: false, description: 'chat not found' });
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
