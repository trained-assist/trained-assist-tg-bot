import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  isTestChat, testChatList, reserveChatId, realChatId, applyTestDelivery,
  initTestMode, isTestChatCached, suppress, rememberCallback, callbackChatId,
} from '../src/lib/test-mode.js';
import { RunOutbox } from '../src/run-outbox.js';

// G1/G6 — unit core of the test mode (DESIGN §2.1/§2.2): fail-safe parsing,
// the reserve-id invariant, the single switchover, and the outbox last hop.

const TEST = 777000111;
const CTRL = 777000222;
const envOf = ids => ({ TEST_CHAT_IDS: ids });

beforeEach(() => vi.spyOn(console, 'log').mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe('isTestChat — fail-safe (R13) и инвариант «чужой чат не матчится»', () => {
  it('нет переменной / пусто / мусор → false', () => {
    expect(isTestChat({}, TEST)).toBe(false);
    expect(isTestChat(envOf(''), TEST)).toBe(false);
    expect(isTestChat(envOf('   '), TEST)).toBe(false);
    expect(isTestChat(envOf('abc, , ,xyz'), TEST)).toBe(false);
    expect(isTestChat(envOf('null'), TEST)).toBe(false);
  });
  it('матчит только явно перечисленные id, включая отрицательные group-id', () => {
    const env = envOf(`${TEST}, -100999`);
    expect(isTestChat(env, TEST)).toBe(true);
    expect(isTestChat(env, String(TEST))).toBe(true); // Number-сравнение
    expect(isTestChat(env, -100999)).toBe(true);
    expect(isTestChat(env, CTRL)).toBe(false);   // не из списка — никогда
    expect(isTestChat(env, 0)).toBe(false);
    expect(isTestChat(env, undefined)).toBe(false);
    expect(isTestChat(envOf(`${TEST}`), 777000110)).toBe(false); // ±1 не матч
  });
  it('testChatList отдаёт распарсенный список', () => {
    expect(testChatList(envOf('1, 2,x,3'))).toEqual([1, 2, 3]);
    expect(testChatList(envOf(''))).toEqual([]);
  });
});

describe('резервный id (слой B): обратим и безопасен', () => {
  const env = envOf(`${TEST}, -100999`);
  it('форма -(1e14+i), отрицательный safe-integer, инъекционный', () => {
    expect(reserveChatId(env, TEST)).toBe(-(1e14 + 0));
    expect(reserveChatId(env, -100999)).toBe(-(1e14 + 1));
    const r = reserveChatId(env, TEST);
    expect(Number.isSafeInteger(r) && r < 0).toBe(true);
  });
  it('realChatId переводит резерв обратно для КАЖДОГО id списка', () => {
    for (const id of testChatList(env)) {
      expect(realChatId(env, reserveChatId(env, id))).toBe(id);
    }
  });
  it('не-тестовые id проходят без изменений', () => {
    expect(realChatId(env, CTRL)).toBe(CTRL);
    expect(realChatId(env, -1001)).toBe(-1001);
    expect(realChatId(envOf(''), -(1e14))).toBe(-(1e14)); // список пуст → не переводим
    expect(realChatId(env, 'nope')).toBe('nope');
    expect(reserveChatId(env, CTRL)).toBe(CTRL);
  });
});

describe('applyTestDelivery — ОДНО ветвление: флаг + резерв', () => {
  it('тестовый чат: подменяет chatId/userId, ставит delivery, логирует run-start с РЕАЛЬНЫМ id', () => {
    const env = envOf(String(TEST));
    const body = { userId: TEST, chatId: TEST, username: 'u', task: 't', requestId: 'r-1' };
    expect(applyTestDelivery(env, body)).toBe(true);
    expect(body.delivery).toBe('log');
    expect(body.chatId).toBe(-(1e14));
    expect(body.userId).toBe(body.chatId);
    const line = console.log.mock.calls.map(c => c.join(' ')).find(l => l.includes('run-start'));
    expect(line).toContain(`[test-mode] run-start chat=${TEST} requestId=r-1 delivery=log`);
  });
  it('обычный чат: body байт-в-байт прежний, false, ни одной строки журнала', () => {
    const env = envOf(String(TEST));
    const body = { userId: CTRL, chatId: CTRL, username: 'u', task: 't' };
    const before = JSON.stringify(body);
    expect(applyTestDelivery(env, body)).toBe(false);
    expect(JSON.stringify(body)).toBe(before);
    expect(body.delivery).toBeUndefined();
    expect(console.log).not.toHaveBeenCalled();
  });
  it('режим выключен: пустой TEST_CHAT_IDS не трогает даже свой id', () => {
    const body = { userId: TEST, chatId: TEST };
    expect(applyTestDelivery(envOf(''), body)).toBe(false);
    expect(body.chatId).toBe(TEST);
  });
});

describe('модульный кэш для lib/telegram.js (init-точки)', () => {
  it('без init → ничего не матчится (fail-safe)', () => {
    expect(isTestChatCached(TEST)).toBe(false);
  });
  it('после init матчит только чаты этого env', () => {
    initTestMode(envOf(String(TEST)));
    expect(isTestChatCached(TEST)).toBe(true);
    expect(isTestChatCached(CTRL)).toBe(false);
    initTestMode(envOf(''));
    expect(isTestChatCached(TEST)).toBe(false);
  });
  it('sandbox allowlist defaults to test chats when Telegram slice routing is enabled', () => {
    expect(isTestChat({ TG_HTTP_TEST_MODE: 'true', TG_SLICE_ALLOWED_CHATS: '-123,456' }, -123)).toBe(true);
    expect(isTestChat({ TG_HTTP_TEST_MODE: 'true', TG_SLICE_ALLOWED_CHATS: '-123,456' }, 456)).toBe(true);
    expect(isTestChat({ TG_HTTP_TEST_MODE: 'true', TG_SLICE_ALLOWED_CHATS: '-123,456', TEST_CHAT_IDS: '' }, -123)).toBe(false);
  });
  it('suppress возвращает заглушку и пишет строку журнала', () => {
    const r = suppress(TEST, 'sendMessage', 'привет');
    expect(r).toEqual({ ok: true, suppressed: true });
    expect(r.result).toBeUndefined(); // recordSent/trackUI не должны получить message_id
    const line = console.log.mock.calls.map(c => c.join(' ')).find(l => l.includes('kind=sendMessage'));
    expect(line).toContain(`kind=sendMessage chat=${TEST} text=привет`);
  });
});

describe('callback-реестр (G2): ack подавляется только зарегистрированный', () => {
  it('зарегистрированный → chatId, чужой → null', () => {
    rememberCallback('cb-test', TEST);
    expect(callbackChatId('cb-test')).toBe(TEST);
    expect(callbackChatId('cb-unknown')).toBeNull();
    rememberCallback('cb-ctrl', CTRL);
    expect(callbackChatId('cb-ctrl')).toBe(CTRL);
  });
});

// ── G6: последний хоп RunOutbox.alarm ────────────────────────────────────────
function outboxFixture(env) {
  const data = new Map(); let alarm = null;
  const storage = {
    get: async k => data.get(k), put: async (k, v) => data.set(k, structuredClone(v)),
    delete: async k => data.delete(k),
    list: async ({ prefix, limit }) => new Map([...data].filter(([k]) => k.startsWith(prefix)).slice(0, limit)),
    setAlarm: async v => { alarm = v; }, deleteAlarm: async () => { alarm = null; },
    transaction: async fn => fn(storage),
  };
  const state = { storage, blockConcurrencyWhile: fn => fn() };
  return { data, state, env, outbox: new RunOutbox(state, env) };
}

describe('RunOutbox.alarm — свап на последнем хопе', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('тестовый чат: /run получает резерв+delivery, job.chatId остаётся реальным', async () => {
    const env = {
      AGENT_URL: 'https://agent', AGENT_SECRET: 's', BOT_TOKEN: 't',
      TEST_CHAT_IDS: String(TEST),
    };
    const f = outboxFixture(env);
    await f.outbox.fetch(new Request('https://outbox', {
      method: 'POST',
      body: JSON.stringify({ agentUrl: 'https://agent', body: { requestId: 'r1', userId: TEST, username: 'u', task: 'work' } }),
    }));
    // job.chatId (для notify / releaseIntakeBusy) фиксируется РЕАЛЬНЫМ при enqueue
    expect(f.data.get('job:r1').chatId).toBe(TEST);
    const runs = []; const tg = [];
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      const u = String(url);
      if (u.endsWith('/maintenance')) return Response.json({ durableIngress: 1 });
      if (u.includes('telegram')) { tg.push(JSON.parse(opts.body)); return Response.json({ ok: true }); }
      runs.push(JSON.parse(opts.body));
      return Response.json({ durable: true, requestId: 'r1', taskId: 'r1' });
    }));
    await f.outbox.alarm();
    expect(runs).toHaveLength(1);
    expect(runs[0].delivery).toBe('log');
    expect(runs[0].chatId).toBe(-(1e14));
    expect(runs[0].userId).toBe(runs[0].chatId);
    expect(runs[0].task).toBe('work');
    expect(tg).toHaveLength(0);
    const line = console.log.mock.calls.map(c => c.join(' ')).find(l => l.includes('run-start'));
    expect(line).toContain(`chat=${TEST}`);
  });

  it('обычный чат: payload не тронут, notify уходит в Telegram', async () => {
    const env = { AGENT_URL: 'https://agent', AGENT_SECRET: 's', BOT_TOKEN: 't', TEST_CHAT_IDS: '' };
    const f = outboxFixture(env);
    await f.outbox.fetch(new Request('https://outbox', {
      method: 'POST',
      body: JSON.stringify({ agentUrl: 'https://agent', body: { requestId: 'r2', userId: CTRL, chatId: CTRL, username: 'u', task: 'work' } }),
    }));
    const runs = []; const tg = [];
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      const u = String(url);
      if (u.endsWith('/maintenance')) return Response.json({ durableIngress: 1 });
      if (u.includes('telegram')) { tg.push(JSON.parse(opts.body)); return Response.json({ ok: true }); }
      runs.push(JSON.parse(opts.body));
      return Response.json({ durable: true, requestId: 'r2', taskId: 'r2' });
    }));
    await f.outbox.alarm();
    expect(runs[0].chatId).toBe(CTRL);
    expect(runs[0].delivery).toBeUndefined();
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('[test-mode]'));
  });
});
