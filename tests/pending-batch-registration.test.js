import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Сторона накопителя: приём РЕГИСТРИРУЕТ пакет наружу, запуск и очистка ЗАКРЫВАЮТ
// его (arch#132 R9). Ключевое свойство всей конструкции —best-effort: ни один из
// этих вызовов не имеет права сорвать приём сообщения или запуск, иначе детектор,
// который мы строим, сам станет причиной тишины.

vi.mock('../src/handlers/message.js', () => ({
  handleMessage: vi.fn(async (_msg, _env, opts) => { opts.onRunAccepted?.({ requestId: 'req-1', taskId: 'ut-1' }); }),
  processDueRetries: vi.fn(async () => {}),
}));
vi.mock('../src/intake-preflight.js', () => ({
  preflight: vi.fn(async msg => ({ msg })),
}));
vi.mock('../src/lib/telegram.js', () => ({
  sendMessage: vi.fn(async () => ({ ok: true, result: { message_id: 1 } })),
  sendMessageWithKeyboard: vi.fn(async () => ({ ok: true, result: { message_id: 2 } })),
  sendDocument: vi.fn(async () => ({ ok: true })),
  editMessage: vi.fn(async () => ({ ok: true })),
  editMessageReplyMarkup: vi.fn(async () => ({ ok: true })),
  deleteMessage: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../src/lib/agent-client.js', () => ({ checkCompleteness: vi.fn(async () => ({ level: 'clear', complete: true })) }));
vi.mock('../src/lib/kv.js', () => ({
  getSession: vi.fn(async () => ({ username: 'vova-cloud-god', projectId: 'p', audienceId: 'default' })),
}));

const { IntakeBuffer } = await import('../src/intake-buffer.js');

function makeState() {
  const map = new Map(); let alarm = null;
  return {
    storage: {
      async list({ prefix = '', limit = 1000 } = {}) { return new Map([...map].filter(([k]) => k.startsWith(prefix)).slice(0, limit)); },
      async get(k) { return map.has(k) ? map.get(k) : undefined; },
      async put(k, v) { map.set(k, v); },
      async delete(k) { map.delete(k); },
      async getAlarm() { return alarm; },
      async setAlarm(t) { alarm = t; },
      async deleteAlarm() { alarm = null; },
      async transaction(fn) { return fn(this); },
    },
    _dump: () => ({ map, alarm }),
  };
}

const ENV = () => ({
  BOT_TOKEN: 't',
  CONTROL_PLANE_URL: 'https://cp.test',
  CONTROL_PLANE_SECRET: 'shhh',
  CONTROL_PLANE_PRINCIPAL: 'gateway',
});

let msgId = 100;
const ingestReq = (text) => new Request('https://intake/ingest', {
  method: 'POST', body: JSON.stringify({ text, msg: { chat: { id: 42 }, text, message_id: ++msgId } }),
});
const flushReq = () => new Request('https://intake/flush', { method: 'POST' });
const clearReq = () => new Request('https://intake/clear', { method: 'POST' });

const cpCalls = (spy) => spy.mock.calls
  .filter(([url]) => String(url).includes('/intake/pending'))
  .map(([, init]) => ({ url: String(init ? '' : ''), path: '', body: JSON.parse(init.body) }))
  .map((c, i) => c);

let fetchSpy;
const bodies = () => fetchSpy.mock.calls
  .filter(([url]) => String(url).includes('/intake/pending'))
  .map(([, init]) => JSON.parse(init.body));

const paths = () => fetchSpy.mock.calls
  .filter(([url]) => String(url).includes('/intake/pending'))
  .map(([url]) => String(url).replace('https://cp.test', ''));

beforeEach(() => {
  fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => vi.unstubAllGlobals());

describe('накопитель регистрирует пакет наружу (arch#132 R9)', () => {
  it('приём сообщения сообщает control plane о пакете с адресом доставки', async () => {
    const io = new IntakeBuffer(makeState(), ENV());
    await io.fetch(ingestReq('сделай отчёт'));

    expect(paths()).toEqual(['/intake/pending']);
    const [body] = bodies();
    expect(body).toMatchObject({ profileId: 'vova-cloud-god', destinationId: '42', prepState: 'collecting' });
    expect(typeof body.firstMessageAt).toBe('number');
    expect(body.deadlineMs).toBeGreaterThan(60_000); // щедрая граница: пользователь законно думает
  });

  it('время ПЕРВОГО сообщения не перебивается новыми', async () => {
    const io = new IntakeBuffer(makeState(), ENV());
    await io.fetch(ingestReq('первое'));
    await new Promise((r) => setTimeout(r, 5));
    await io.fetch(ingestReq('второе'));
    await new Promise((r) => setTimeout(r, 5));
    await io.fetch(ingestReq('третье'));

    const times = bodies().map((b) => b.firstMessageAt);
    expect(times).toHaveLength(3);
    expect(new Set(times).size).toBe(1); // одно время на весь пакет
    expect(bodies().map((b) => b.batchId).every((id) => id === bodies()[0].batchId)).toBe(true);
  });

  it('запуск закрывает пакет и СВЯЗЫВАЕТ его с задачей', async () => {
    const io = new IntakeBuffer(makeState(), ENV());
    await io.fetch(ingestReq('сделай отчёт'));
    fetchSpy.mockClear();

    await io.fetch(flushReq());
    await new Promise((r) => setTimeout(r, 10));

    expect(paths()).toEqual(['/intake/pending/gone']);
    expect(bodies()[0]).toMatchObject({ reason: 'launched', userTaskId: 'ut-1' });
  });

  it('очистка буфера закрывает пакет — решение пользователя это не зависание', async () => {
    const io = new IntakeBuffer(makeState(), ENV());
    await io.fetch(ingestReq('сделай отчёт'));
    fetchSpy.mockClear();

    await io.fetch(clearReq());

    expect(paths()).toEqual(['/intake/pending/gone']);
    expect(bodies()[0]).toMatchObject({ reason: 'cleared' });
  });

  it('недоступность control plane не срывает приём и не срывает запуск', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const io = new IntakeBuffer(makeState(), ENV());

    const res = await io.fetch(ingestReq('сделай отчёт'));
    expect(res.status).toBe(200);                    // приём состоялся
    const state = io.state;
    expect((await state.storage.get('buf'))?.length).toBe(1);

    await io.fetch(flushReq());                      // запуск не должен упасть
    await new Promise((r) => setTimeout(r, 10));
    expect(await state.storage.get('busy')).toBe(true); // ран идёт, несмотря на молчащий control plane
  });

  it('исключение из наблюдаемости не превращается в «сбой запуска»', async () => {
    const io = new IntakeBuffer(makeState(), ENV());
    await io.fetch(ingestReq('сделай отчёт'));
    // Сломанный клиент бросает СИНХРОННО (не Promise rejection) — самый опасный вид.
    const pending = await import('../src/lib/pending-intake.js');
    const spy = vi.spyOn(pending, 'closePendingBatch').mockImplementation(() => { throw new Error('boom'); });

    await io.fetch(flushReq());
    await new Promise((r) => setTimeout(r, 10));
    expect(await io.state.storage.get('busy')).toBe(true);
    spy.mockRestore();
  });

  it('без настройки control plane шлюз ведёт себя как раньше', async () => {
    const io = new IntakeBuffer(makeState(), { BOT_TOKEN: 't' });
    await io.fetch(ingestReq('сделай отчёт'));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await io.state.storage.get('buf'))?.length).toBe(1);
  });
});
