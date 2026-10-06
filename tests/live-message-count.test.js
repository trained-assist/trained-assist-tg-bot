import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import worker, { dispatchInner } from '../src/index.js';
import { IntakeBuffer } from '../src/intake-buffer.js';
import { RunOutbox } from '../src/run-outbox.js';
import { setSession } from '../src/lib/kv.js';

// ── PR1 characterization: СКОЛЬКО СООБЩЕНИЙ СОЗДАЁТ БОТ НА ЗАПУСК ───────────
// (инвариант «одно живое сообщение на запуск», issue #328, этап PR1)
//
// Считаются РЕАЛЬНЫЕ вызовы Telegram API на уровне fetch (не mock-функции):
//   send  = sendMessage / sendDocument  → новое сообщение в чате
//   edit  = editMessageText / editMessageReplyMarkup → правка существующего
// Запуск = один POST /run, ушедший агенту (runBodies).
//
// Это характеризация ТЕКУЩЕГО поведения на 9a8647a, включая известные
// особенности (удержанная порция создаёт свой пузырь, «⚡ Параллельно»
// отвечает отдельным сообщением). Счёт фиксирует базу: PR2 (LegacyBackend)
// и PR-A2 (liveMessageId) не должны менять числа незаметно — любое изменение
// здесь = осознанная правка в том же PR с объяснением.
//
// Харнесс как в test-mode-scenario: НАСТОЯЩИЕ dispatchInner → IntakeBuffer →
// handleMessage → RunOutbox; на границе сети — фейки Telegram и агента.

const CHAT = 555000111;
const AGENT = 'https://agent.test';
const AGENT_SECRET = 'sandbox-secret';
const dgram = 'https://api.deepgram.com/v1/listen?model=nova-2&language=ru&smart_format=true';

const tg = [];        // все вызовы Telegram API: {method, chatId, text, buttons}
const runBodies = []; // ушедшие в агент POST /run

let activeBuffers = null; // Map<conversationKey, IntakeBuffer> — свой мир на каждый test
let activeOutbox = null;

const bodyOf = init => { try { return JSON.parse(init?.body || '{}'); } catch { return {}; } };
const drain = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };

async function fakeFetch(url, init = {}) {
  const u = String(url);
  if (u.startsWith('https://api.telegram.org/')) {
    const method = u.split('/').pop().split('?')[0];
    const b = bodyOf(init);
    const buttons = (b.reply_markup?.inline_keyboard || []).flat().map(x => x.callback_data || x.text).filter(Boolean);
    tg.push({ method, chatId: b.chat_id, text: b.text || b.caption || '', buttons });
    if (method === 'getFile') {
      return Response.json({ ok: true, result: { file_path: 'photos/a.jpg', file_size: 1000 } });
    }
    return Response.json({ ok: true, result: { message_id: 7000 + tg.length, date: Math.floor(Date.now() / 1000) } });
  }
  if (u.includes('/file/bot')) return new Response(new Uint8Array([1, 2, 3, 4]));
  if (u.startsWith(dgram)) {
    return Response.json({ results: { channels: [{ alternatives: [{ transcript: 'сделай анализ откликов', confidence: 0.9 }] }] } });
  }
  if (u.startsWith(`${AGENT}/`)) {
    const path = u.slice(AGENT.length);
    if (path.startsWith('/maintenance')) return Response.json({ durableIngress: 1 });
    if (path.startsWith('/run')) {
      const b = bodyOf(init);
      runBodies.push(b);
      return Response.json({ durable: true, requestId: b.requestId, taskId: b.requestId });
    }
    if (path.startsWith('/intake-gate')) return Response.json({ level: 'clear', delayMs: 180000, announce: null });
    if (path.startsWith('/intake-quick')) return Response.json({ answer: null });
    if (path.startsWith('/project-decision')) return Response.json({ action: 'auto' });
    if (path.startsWith('/sessions')) return Response.json({ sessions: [] });
    if (path.startsWith('/classify')) return Response.json({ confidence: 'high', sessionId: 's-1' });
    if (path.startsWith('/capabilities')) return Response.json({ capabilities: [] });
    if (path.startsWith('/tasks/running')) return Response.json({ running: false });
    if (path.startsWith('/health')) return Response.json({ status: 'alive' });
    if (path.startsWith('/intake-files')) {
      if ((init.method || 'GET') === 'PUT') {
        const q = new URL(u).searchParams;
        const id = q.get('id');
        // `path` — контракт trained-assist-agent#2052: путь, по которому скил
        // speech_transcribe сам прочитает файл (Ф4, tg-bot#319).
        return Response.json({ id, name: q.get('name') || 'f', mime: init.headers?.['Content-Type'] || 'image/jpeg', size: 4,
          path: `media/intake-store/${id}/data` });
      }
      return Response.json({ ok: true }); // release / read
    }
    // Ф4 (#319): распознавание речи идёт мостом POST /action, а не напрямую в Deepgram.
    // Текст так же берём из той же «транскрипции», что и раньше — меняется транспорт,
    // не содержимое.
    if (path.startsWith('/action')) {
      const req = bodyOf(init);
      if (req.tool !== 'speech_transcribe') return Response.json({ ok: false, error: 'unknown tool' }, { status: 404 });
      return Response.json({ ok: true, result: { text: 'сделай анализ откликов', duration: 2, language: 'ru' } });
    }
    return Response.json({ ok: false }, { status: 404 });
  }
  throw new Error(`неожиданный fetch: ${u}`);
}

function makeState() {
  const data = new Map();
  let alarm = null;
  const storage = {
    get: async k => data.get(k),
    put: async (k, v) => { data.set(k, structuredClone(v)); },
    delete: async k => { data.delete(k); },
    list: async ({ prefix = '', limit = 1000 } = {}) =>
      new Map([...data].filter(([k]) => k.startsWith(prefix)).slice(0, limit)),
    getAlarm: async () => alarm,
    setAlarm: async t => { alarm = t; },
    deleteAlarm: async () => { alarm = null; },
    transaction: async fn => fn(storage),
  };
  return { data, state: { storage, blockConcurrencyWhile: fn => fn() } };
}

// Свежий мир: KV + свои IntakeBuffer/RunOutbox на каждый сценарий.
async function makeWorld() {
  const kv = new Map();
  activeBuffers = new Map();
  const outboxBox = makeState();
  const env = {
    BOT_TOKEN: '123456:SBX',
    INTAKE_DEBOUNCE: 'on',
    AGENT_URL: AGENT,
    AGENT_SECRET,
    SESSIONS: {
      get: async (k, o) => (o?.type === 'json' ? JSON.parse(kv.get(k) ?? 'null') : kv.get(k) ?? null),
      put: async (k, v) => { kv.set(k, v); },
      delete: async k => { kv.delete(k); },
      list: async () => ({ keys: [] }),
    },
    INTAKE: {
      idFromName: n => n,
      get: name => {
        if (!activeBuffers.has(name)) activeBuffers.set(name, new IntakeBuffer(makeState().state, env));
        const io = activeBuffers.get(name);
        return { fetch: (url, init) => io.fetch(new Request(url, init)) };
      },
    },
    RUN_OUTBOX: {
      idFromName: n => n,
      get: () => {
        const o = new RunOutbox(outboxBox.state, env);
        return { fetch: (url, init) => o.fetch(new Request(url, init)) };
      },
    },
  };
  activeOutbox = new RunOutbox(outboxBox.state, env);
  await setSession(env.SESSIONS, CHAT, {
    username: 'owner', lastSessionId: 's-1', lastMessageAt: Date.now(),
    pinnedMsgId: null, telegramUserId: CHAT,
  });
  return { env };
}

const mk = (text, id) => ({
  message_id: id, date: Math.floor(Date.now() / 1000),
  chat: { id: CHAT, type: 'private' }, from: { id: CHAT, username: 'owner' }, text,
});

const say = async (env, text, id) => {
  await dispatchInner({ update_id: id, message: mk(text, id) }, env);
  await drain();
};

// Показать коллектор по расписанию (receiptDue → alarm), как это делает таймер.
async function quiet(env) {
  env.INTAKE.get(env.INTAKE.idFromName(String(CHAT))); // гарантировать инстанс
  const buffer = [...activeBuffers.values()][0];
  await buffer.state.storage.put('receiptDue', Date.now() - 1);
  await buffer.alarm();
  await drain();
}

// Доставка: реальный outbox → фейковый агент.
async function deliver() {
  await activeOutbox.alarm();
  await drain();
}

// Агент донёс результат — как это делает src/gateway-callback.js.
async function finishRun(env, requestId) {
  const res = await worker.fetch(new Request('https://worker.test/internal/run-finished', {
    method: 'POST',
    headers: { Authorization: `Bearer ${AGENT_SECRET}` },
    body: JSON.stringify({ chatId: CHAT, requestId, taskId: requestId, outcome: 'done', consumed: [] }),
  }), env);
  expect(res.status).toBe(200);
  await drain();
}

const sends = () => tg.filter(t => t.method === 'sendMessage' || t.method === 'sendDocument');
const edits = () => tg.filter(t => t.method === 'editMessageText' || t.method === 'editMessageReplyMarkup');
const mark = () => ({ from: tg.length });
const sinceSend = m => sends().slice(sends().length - (sends().length - m.sendsCount));

beforeAll(() => { vi.stubGlobal('fetch', vi.fn(fakeFetch)); });
afterAll(() => { vi.unstubAllGlobals(); });

beforeEach(() => { tg.length = 0; runBodies.length = 0; });

describe('PR1 — счёт сообщений бота на запуск (characterization #328)', () => {
  it('A. Текст: 3 сообщения + force-слово → один запуск, бот создаёт ровно ОДНО сообщение (коллектор)', async () => {
    const { env } = await makeWorld();
    await say(env, 'нужен разбор откликов на вакансию', 1);
    await say(env, 'стек: Go, Postgres', 2);
    await quiet(env);                     // таймер показал коллектор «✓ Получил 2…»
    const afterReceipt = sends().length;
    expect(afterReceipt, 'коллектор должен быть создан один раз').toBe(1);

    await say(env, 'запускай', 3);        // force → flush → dispatch
    await deliver();
    expect(runBodies).toHaveLength(1);    // ровно один запуск

    // Статус «📨 Передаю собранный input агенту…» — ПРАВКА коллектора, не send.
    const dispatchMsgs = tg.slice(tg.findIndex(t => t.text?.includes('Передаю собранный')) >= 0 ? 0 : 0);
    expect(sends().length, 'на запуск не должно родиться второго сообщения').toBe(afterReceipt);
    expect(tg.some(t => t.method === 'editMessageText' && t.text?.includes('Передаю собранный')),
      'статус должен жить правкой коллектора').toBe(true);

    await finishRun(env, runBodies[0].requestId);
    expect(sends().length, 'завершение рана не создаёт сообщений').toBe(afterReceipt);
    void dispatchMsgs;
  });

  it('B. Последовательная порция: 5 сообщений, коллектор растёт правками, на запуске — 0 новых send', async () => {
    const { env } = await makeWorld();
    for (let i = 1; i <= 5; i++) {
      await say(env, `пункт задачи номер ${i}`, i);
      await quiet(env);
    }
    expect(sends().length, 'коллектор один на всю порцию, дальше только правки').toBe(1);
    const editsBeforeLaunch = edits().length;
    expect(editsBeforeLaunch, 'каждая правка счётчика — edit того же сообщения').toBeGreaterThanOrEqual(4);

    await say(env, 'го', 99);
    await deliver();
    expect(runBodies).toHaveLength(1);
    expect(sends().length, 'запуск порции не создаёт сообщений — только правки').toBe(1);
    const task = runBodies[0].task;
    for (let i = 1; i <= 5; i++) expect(task).toContain(`пункт задачи номер ${i}`);
  });

  it('C. Busy-окно: сообщение во время рана создаёт свой пузырь удержания (исключение «ввод, не статус»)', async () => {
    const { env } = await makeWorld();
    await say(env, 'сделай 큰 проработку', 1);
    await quiet(env);
    await say(env, 'запускай', 2);
    await deliver();
    expect(runBodies).toHaveLength(1);
    expect(sends().length).toBe(1);       // только коллектор

    // Пока агент работает — пользователь пишет ещё.
    await say(env, 'и добавь зарплатные вилки', 3);
    await quiet(env);                     // показался пузырь «✓ Получил ещё 1…»
    expect(sends().length,
      'удержанное сообщение — исключение инварианта: это ввод, а не статус').toBe(2);
    expect(tg.at(-1).text).toContain('пока идёт задача');

    await finishRun(env, runBodies[0].requestId);
    // После релиза удержанная порция получает кнопку — правкой СВОЕГО пузыря.
    expect(sends().length, 'завершение не плодит сообщений — коллектор переиспользуется').toBe(2);
    expect(tg.some(t => t.method === 'editMessageText' && t.buttons?.some(b => b.startsWith('intake_run'))),
      '▶️ возвращается правкой пузыря удержания').toBe(true);
  });

  it('D. Ошибка доставки: отказ агента (HTTP 400) — правка статуса, не новое сообщение', async () => {
    const { env } = await makeWorld();
    // Агент отклоняет работу (журнал /run ведём как обычно — это «запуск состоялся»).
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (String(url).startsWith(`${AGENT}/run`)) {
        runBodies.push(bodyOf(init));
        return Response.json({ error: 'bad' }, { status: 400 });
      }
      return realFetch(url, init);
    }));
    try {
      await say(env, 'проверь налоги за квартал', 1);
      await quiet(env);
      await say(env, 'запускай', 2);
      await deliver();
      await drain();

      expect(runBodies).toHaveLength(1);
      expect(sends().length, 'отказ сервера не создаёт нового сообщения').toBe(1);
      expect(tg.some(t => t.method === 'editMessageText' && t.text?.includes('Задача сохранена, но сервер отклонил')),
        'ошибка доставки живёт правкой статусного сообщения').toBe(true);
    } finally {
      vi.stubGlobal('fetch', vi.fn(fakeFetch)); // вернуть штатный фейк: D не должна отравить E/F
    }
  });

  it('E. Параллельный ран: второй запуск получает СВОЁ живое сообщение (итог: 2 send на 2 запуска)', async () => {
    const { env } = await makeWorld();
    await say(env, 'первая задача', 1);
    await quiet(env);
    await say(env, 'запускай', 2);
    await deliver();
    expect(runBodies).toHaveLength(1);
    expect(sends().length).toBe(1);

    // Пока идёт — пришла порция, затем явный «⚡ Параллельно».
    await say(env, 'вторая задача', 3);
    await quiet(env);                     // пузырь удержания — send #2
    expect(sends().length).toBe(2);

    await dispatchInner({ update_id: 4, callback_query: {
      id: 'cb1', from: { id: CHAT, username: 'owner' }, chat_instance: 'ci',
      data: 'intake_parallel', message: { message_id: 9000, chat: { id: CHAT, type: 'private' } },
    } }, env);
    await drain();
    await deliver();
    expect(runBodies, 'параллельный тап должен увести второй /run').toHaveLength(2);

    // Итог по инварианту: 3 сообщения на ВСЮ картину — коллектор ввода,
    // пузырь удержания (ввод) и подтверждение «⚡». Статусы ОБОИХ запусков —
    // правки существующих пузырей, новые send на запуск не создаются.
    const sendsTotal = sends().length;
    const parallelAck = tg.find(t => t.text?.startsWith('⚡ Запускаю параллельно'));
    expect(parallelAck, 'подтверждение параллельного запуска — отдельное сообщение (текущее поведение)').toBeDefined();
    expect(sendsTotal).toBe(3);
    expect(sends().filter(t => t.text?.includes('Передаю собранный')).length,
      'каждый запуск рисует статус ПРАВКОЙ своего пузыря, не новым send').toBe(0);
  });

  it('F. Голос + текст: STT и файл уходят без лишних send — на запуске по-прежнему 1 сообщение', async () => {
    const { env } = await makeWorld();
    await dispatchInner({ update_id: 1, message: {
      message_id: 11, date: Math.floor(Date.now() / 1000),
      chat: { id: CHAT, type: 'private' }, from: { id: CHAT, username: 'owner' },
      voice: { file_id: 'AAA', file_unique_id: 'ua', file_size: 500 },
    } }, env);
    await drain();
    await say(env, 'и сделай выводы', 12);
    await quiet(env);
    expect(sends().length, 'расшифровка в батче не шлётся отдельным сообщением').toBe(1);
    expect(tg.some(t => t.text?.startsWith('🎤 ')),
      'голос в порции НЕ дублируется в чат — транскрипт едет в input').toBe(false);

    await say(env, 'запускай', 13);
    await deliver();
    expect(runBodies).toHaveLength(1);
    expect(sends().length, 'запуск с голосом не создаёт лишних сообщений').toBe(1);
    expect(runBodies[0].task, 'транскрипт должен быть в задаче').toContain('сделай анализ откликов');
    expect(runBodies[0].task).toContain('и сделай выводы');
  });
});
