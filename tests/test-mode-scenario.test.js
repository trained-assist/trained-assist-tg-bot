import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import worker, { dispatchInner } from '../src/index.js';
import { IntakeBuffer } from '../src/intake-buffer.js';
import { RunOutbox } from '../src/run-outbox.js';
import { setSession } from '../src/lib/kv.js';

// ── ПЕСОЧНИЦА US-TEST-01 (шаг 6 плана «Тестовый режим шлюза», план f45565a2) ──
//
// Замкнутый цикл, который агент прогоняет ОДНОЙ командой без человека:
//   npm run test:scenario        (эквивалент: npm test -- tests/test-mode-scenario.test.js)
// Детерминированный вывод pass/fail — exit-код vitest (0 = зелёный).
//
// Что здесь реально (не замокано): web-вход шлюза dispatchInner → routeText →
// настоящий IntakeBuffer DO → настоящий handleMessage → настоящий runTask →
// настоящий RunOutbox → POST /run → настоящий /internal/run-finished.
// Внешние зависимости — фейки на границе сети: Telegram (перехват fetch к
// api.telegram.org) и агент (HTTP-стенд /maintenance, /run, отдаёт run-finished
// с answer по контракту DESIGN.md §2.3). Уровень автономности: S5 локально
// (полный замкнутый цикл за секунды, внешние сервисы — фейки); staging с
// реальными зависимостями — смоук шага 13 плана.
//
// Форматы журнала зафиксированы DESIGN.md §2.2 («по ним пишется автотест»):
//   [test-mode] run-start chat=<реальный id> requestId=<id> delivery=log
//   [test-mode] kind=sendMessage chat=<id> text=<300 символов>…
//   [test-mode] kind=run-finished chat=<id> requestId=<id> outcome=done|error|stopped|quick
//   [test-mode] kind=agent-answer chat=<id> requestId=<id> len=<n> text=<до 4000>
// Резервный (мёртвый) id тестового чата: -(1e14 + i), DESIGN.md §2.1.

const TEST_CHAT = 777000111;
const CTRL_CHAT = 777000222;
const AGENT = 'https://agent.test';
const AGENT_SECRET = 'sandbox-secret';
const AGENT_ANSWER = 'Sandbox: ответ агента прошёл весь путь и попал в журнал, а не в чат.';

let active = null;      // журнал/записи ТЕКУЩЕГО прогона
const stray = [];       // обращения вне активного прогона (диагностика)

const fmt = a => a.map(x => {
  if (typeof x === 'string') return x;
  if (x instanceof Error) return x.message;
  try { return JSON.stringify(x); } catch { return String(x); }
}).join(' ');

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

const drain = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };
const bodyOf = init => { try { return JSON.parse(init?.body || '{}'); } catch { return {}; } };

async function fakeFetch(url, init = {}) {
  const u = String(url);
  const sink = active;
  if (u.startsWith('https://api.telegram.org/')) {
    const method = u.split('/').pop().split('?')[0];
    const b = bodyOf(init);
    const call = { method, chatId: b.chat_id, text: b.text || b.caption || '' };
    if (sink) sink.tg.push(call); else stray.push(u);
    const nextId = sink ? ++sink.tgMid : 1;
    return Response.json({ ok: true, result: { message_id: nextId, date: Math.floor(Date.now() / 1000) } });
  }
  if (u.startsWith(`${AGENT}/`)) {
    if (!sink) { stray.push(u); return Response.json({}, { status: 404 }); }
    const path = u.slice(AGENT.length);
    if (path.startsWith('/maintenance')) return Response.json({ durableIngress: 1 });
    if (path.startsWith('/run')) {
      const body = bodyOf(init);
      sink.runBodies.push(body);
      return Response.json({ durable: true, requestId: body.requestId, taskId: body.requestId });
    }
    sink.unknown.push(u);
    return Response.json({ ok: false }, { status: 404 });
  }
  if (sink) sink.unknown.push(u); else stray.push(u);
  throw new Error(`sandbox: неожиданный fetch ${u}`);
}

// Один прогон сценария: два сообщения в тестовый/обычный чат → буфер → flush →
// /run → «агент» отвечает run-finished с answer → возврат состояния наружу.
async function runScenario({ chatId, testChatIds }) {
  const store = { journal: [], tg: [], runBodies: [], unknown: [], mid: 900, tgMid: 9000, chatId, testChatIds };
  active = store;
  const kv = new Map();
  const buffers = new Map();
  const outboxBox = makeState();

  try {
    const env = {
      BOT_TOKEN: '123456:SBX',
      INTAKE_DEBOUNCE: 'on',
      AGENT_URL: AGENT,
      AGENT_SECRET,
      TEST_CHAT_IDS: testChatIds,
      SESSIONS: {
        get: async (k, o) => (o?.type === 'json' ? JSON.parse(kv.get(k) ?? 'null') : kv.get(k) ?? null),
        put: async (k, v) => { kv.set(k, v); },
        delete: async k => { kv.delete(k); },
        list: async () => ({ keys: [] }),
      },
      INTAKE: {
        idFromName: n => String(n),
        get: name => {
          if (!buffers.has(name)) buffers.set(name, new IntakeBuffer(makeState().state, env));
          const io = buffers.get(name);
          return { fetch: (url, init) => io.fetch(new Request(url, init)) };
        },
      },
      RUN_OUTBOX: {
        idFromName: n => String(n),
        get: () => {
          const o = new RunOutbox(outboxBox.state, env);
          return { fetch: (url, init) => o.fetch(new Request(url, init)) };
        },
      },
    };
    const outbox = new RunOutbox(outboxBox.state, env);

    await setSession(env.SESSIONS, chatId, {
      username: 'owner', lastSessionId: 's-1', lastMessageAt: Date.now(),
      pinnedMsgId: null, telegramUserId: chatId,
    });

    const mk = text => ({
      message_id: ++store.mid, date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'private' }, from: { id: chatId, username: 'owner' }, text,
    });

    // Шаг 2: обычное сообщение копится в буфере; шаг 3: force-слово флушит пачку.
    await dispatchInner({ update_id: 1, message: mk('проверка тестового режима: полный путь маршрутизации') }, env);
    await dispatchInner({ update_id: 2, message: mk('запускай') }, env);
    await drain();

    const buffer = buffers.get(String(chatId));
    store.bufferFound = !!buffer;
    store.busyBefore = !!(await buffer?.state.storage.get('busy'));

    // Доставка: реальный outbox → фейковый агент.
    await outbox.alarm();
    await drain();

    // «Агент» закончил: POST /internal/run-finished — как это делает
    // src/gateway-callback.js (answer даёт только при delivery:"log", §2.3).
    const runBody = store.runBodies[0] || null;
    if (runBody) {
      const payload = {
        chatId: runBody.chatId, threadId: runBody.threadId ?? null,
        requestId: runBody.requestId, taskId: runBody.requestId,
        outcome: 'done', consumed: [],
      };
      if (runBody.delivery === 'log') payload.answer = AGENT_ANSWER;
      const res = await worker.fetch(new Request('https://worker.test/internal/run-finished', {
        method: 'POST',
        headers: { Authorization: `Bearer ${AGENT_SECRET}` },
        body: JSON.stringify(payload),
      }), env);
      store.runFinishedStatus = res.status;
      await drain();
    }
    store.busyAfter = !!(await buffer?.state.storage.get('busy'));
    return store;
  } catch (e) {
    store.journal.push(`HARNESS ERROR: ${e?.stack || e}`);
    throw e;
  } finally {
    active = null;
  }
}

let L1; // тестовый чат (TEST_CHAT_IDS включён)
let L2; // контрольный чат (режим выключен)

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation((...a) => {
    const line = fmt(a);
    (active ? active.journal : stray).push(line);
  });
  vi.spyOn(console, 'info').mockImplementation((...a) => (active ? active.journal : stray).push(fmt(a)));
  vi.spyOn(console, 'warn').mockImplementation((...a) => (active ? active.journal : stray).push(fmt(a)));
  vi.spyOn(console, 'error').mockImplementation((...a) => (active ? active.journal : stray).push(fmt(a)));
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  L1 = await runScenario({ chatId: TEST_CHAT, testChatIds: String(TEST_CHAT) });
  L2 = await runScenario({ chatId: CTRL_CHAT, testChatIds: '' });
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const dump = s => `\nжурнал:\n${s.journal.slice(-25).join('\n') || '(пусто)'}\nтелеграм: ${
  JSON.stringify(s.tg.map(t => `${t.method}:${t.text?.slice(0, 40)}`))}\n/run: ${
  JSON.stringify(s.runBodies.map(b => ({ delivery: b.delivery, chatId: b.chatId, userId: b.userId })))}`;

describe('US-TEST-01 — тестовый режим шлюза: замкнутый цикл (песочница S5)', () => {
  it('инженерный контур: шлюз доставил /run и принял run-finished', () => {
    expect(L1.bufferFound, 'IntakeBuffer чата не создался').toBe(true);
    expect(L1.busyBefore, 'чат не ушёл в busy — прогон не стартовал').toBe(true);
    expect(L1.runBodies, `POST /run не пришёл агенту${dump(L1)}`).toHaveLength(1);
    expect(L1.runFinishedStatus, 'run-finished не принят').toBe(200);
    expect(L2.runBodies, `контрольный прогон: /run не пришёл${dump(L2)}`).toHaveLength(1);
    expect(L2.runFinishedStatus).toBe(200);
    expect(stray, `обращения вне прогона: ${stray.join(', ')}`).toEqual([]);
  });

  describe('тестовый чат (TEST_CHAT_IDS = 777000111)', () => {
    it('шаг 3: /run уходит агенту с delivery:"log"', () => {
      expect(L1.runBodies[0].delivery, `нет контрактного флага delivery${dump(L1)}`).toBe('log');
    });

    it('шаг 3: chatId/userId подменены на резервный (слой B), payload цел', () => {
      const b = L1.runBodies[0];
      expect(b.chatId, `chatId не подменён: ${b.chatId}`).not.toBe(TEST_CHAT);
      expect(b.userId, `userId не подменён: ${b.userId}`).not.toBe(TEST_CHAT);
      expect(Number.isSafeInteger(b.chatId) && b.chatId < 0, `резервный id не отрицательный: ${b.chatId}`).toBe(true);
      expect(b.chatId).toBe(b.userId);
      expect(String(b.task || '')).toContain('проверка');
    });

    it('шаги 1–2: в Telegram для тестового чата — НИ ОДНОЙ отправки', () => {
      const mine = L1.tg.filter(c => Number(c.chatId) === TEST_CHAT);
      expect(mine, `ушло в Telegram: ${JSON.stringify(mine.map(t => `${t.method}:${t.text?.slice(0, 60)}`))}`).toHaveLength(0);
    });

    it('журнал: строка run-start с реальным chatId и delivery=log', () => {
      const line = L1.journal.find(l => /\[test-mode\] run-start chat=/.test(l));
      expect(line, `нет run-start${dump(L1)}`).toBeDefined();
      expect(line).toContain(`chat=${TEST_CHAT}`);
      expect(line).toContain('delivery=log');
    });

    it('журнал: подавленные отправки ушли в kind=sendMessage', () => {
      const lines = L1.journal.filter(l => /\[test-mode\] kind=sendMessage chat=\d+/.test(l));
      expect(lines.length, `нет kind=sendMessage — отправки не перенаправлены в журнал${dump(L1)}`).toBeGreaterThan(0);
      expect(lines.every(l => l.includes(`chat=${TEST_CHAT}`))).toBe(true);
    });

    it('журнал: строка run-finished с исходом прогона', () => {
      const line = L1.journal.find(l => /\[test-mode\] kind=run-finished chat=/.test(l));
      expect(line, `нет kind=run-finished${dump(L1)}`).toBeDefined();
      expect(line).toContain(`chat=${TEST_CHAT}`);
      expect(line).toContain(`requestId=${L1.runBodies[0].requestId}`);
      expect(line).toMatch(/outcome=(done|error|stopped|quick)/);
    });

    it('шаги 4–5: ответ агента в журнале (kind=agent-answer), не в чате', () => {
      const line = L1.journal.find(l => /\[test-mode\] kind=agent-answer chat=/.test(l));
      expect(line, `нет kind=agent-answer — answer из run-finished не принят/не залогирован${dump(L1)}`).toBeDefined();
      expect(line).toContain(`chat=${TEST_CHAT}`);
      expect(line).toContain(`requestId=${L1.runBodies[0].requestId}`);
      expect(line, 'текст ответа не в журнале').toContain(AGENT_ANSWER);
      expect(L1.tg.filter(c => Number(c.chatId) === TEST_CHAT)).toHaveLength(0);
    });

    it('инверсия резервного id: run-finished отпускает busy РЕАЛЬНОГО чата', () => {
      expect(L1.bufferFound).toBe(true);
      expect(L1.busyAfter, 'busy не отпущен — резервный id не переведён обратно').toBe(false);
    });
  });

  describe('обычный чат (режим выключен — fail-safe)', () => {
    it('отправки шлюза уходят в Telegram как прежде', () => {
      const mine = L2.tg.filter(c => Number(c.chatId) === CTRL_CHAT);
      expect(mine.length, `обычный чат остался без отправок${dump(L2)}`).toBeGreaterThan(0);
    });

    it('/run без delivery, chatId реальный', () => {
      const b = L2.runBodies[0];
      expect(b.delivery).toBeUndefined();
      expect(b.chatId).toBe(CTRL_CHAT);
      expect(b.userId).toBe(CTRL_CHAT);
    });

    it('ни одной строки [test-mode] в журнале', () => {
      const noise = L2.journal.filter(l => l.includes('[test-mode]'));
      expect(noise, `режим сработал не на том чате: ${noise.join('\n')}`).toHaveLength(0);
    });
  });
});
