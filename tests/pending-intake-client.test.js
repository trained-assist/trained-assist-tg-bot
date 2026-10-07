import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { closePendingBatch, controlPlaneHeaders, registerPendingBatch } from '../src/lib/pending-intake.js';

// Регистрация пакета в control plane (arch#132 R9). Границы: канал и durable-приём
// — зона шлюза; общее состояние — control plane. Здесь только след «у меня
// накоплено вот это», и он ВСЕГДА best-effort: детектор не должен сам стать
// причиной тишины.

const ENV = {
  CONTROL_PLANE_URL: 'https://cp.test',
  CONTROL_PLANE_SECRET: 'shhh',
  CONTROL_PLANE_PRINCIPAL: 'gateway',
};

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('клиент регистрации пакета (arch#132 R9)', () => {
  it('подписывает запрос HMAC от principalId — так же, как ждёт control plane', async () => {
    const headers = await controlPlaneHeaders(ENV);
    expect(headers).toBeTruthy();
    expect(headers['x-principal']).toBe('gateway');
    // HMAC-SHA256(secret, principalId) в hex, 64 символа.
    expect(headers['x-principal-sig']).toMatch(/^[0-9a-f]{64}$/);
    const again = await controlPlaneHeaders(ENV);
    expect(again['x-principal-sig']).toBe(headers['x-principal-sig']); // детерминирован
  });

  it('без настройки control plane — no-op, а не ошибка', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await registerPendingBatch({ BOT_TOKEN: 't' }, { batchId: 'b1', profileId: 'p' })).toBe(false);
    expect(await closePendingBatch({ BOT_TOKEN: 't' }, 'b1', 'launched')).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await controlPlaneHeaders({ BOT_TOKEN: 't' })).toBeNull();
  });

  it('регистрирует пакет: batchId, профиль, адрес доставки, время ПЕРВОГО сообщения', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchSpy);

    const ok = await registerPendingBatch(ENV, {
      batchId: '-5111318625#1', profileId: 'vova-cloud-god', destinationId: '-5111318625',
      firstMessageAt: 1700000000000, prepState: 'collecting', deadlineMs: 1800000,
    });

    expect(ok).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://cp.test/intake/pending');
    expect(init.method).toBe('PUT');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      batchId: '-5111318625#1', profileId: 'vova-cloud-god',
      destinationId: '-5111318625', firstMessageAt: 1700000000000,
      prepState: 'collecting', deadlineMs: 1800000, channel: 'telegram',
    });
  });

  it('состояние подготовки отличается: расшифровка — это не потерянный ввод', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchSpy);
    await registerPendingBatch(ENV, { batchId: 'b', profileId: 'p', firstMessageAt: 1, prepState: 'preparing' });
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).prepState).toBe('preparing');
  });

  it('недоступность control plane НЕ ломает приём: false, а не исключение', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    await expect(registerPendingBatch(ENV, { batchId: 'b', profileId: 'p', firstMessageAt: 1 })).resolves.toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'nope' }, 500)));
    await expect(registerPendingBatch(ENV, { batchId: 'b', profileId: 'p', firstMessageAt: 1 })).resolves.toBe(false);
  });

  it('закрытие пакета несёт причину и, если известна задача, связывает её', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ ok: true, linked: true }));
    vi.stubGlobal('fetch', fetchSpy);

    await closePendingBatch(ENV, '-5111318625#2', 'launched', 'ut-abc');
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://cp.test/intake/pending/gone');
    expect(JSON.parse(init.body)).toEqual({ batchId: '-5111318625#2', reason: 'launched', userTaskId: 'ut-abc' });

    fetchSpy.mockClear();
    await closePendingBatch(ENV, '-5111318625#3', 'cleared');
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({
      batchId: '-5111318625#3', reason: 'cleared', userTaskId: null,
    });
  });
});
