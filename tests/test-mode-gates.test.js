import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// G2/G4 — гейты отправок (DESIGN §2.2): init с тестовым id → НИ ОДНОГО fetch к
// Telegram; обычный чат → fetch как прежде; callback-ack подавляется только
// зарегистрированный в dispatchInner callback.

const TEST = 777000111;
const CTRL = 777000222;

const fetchMock = vi.fn(async () => Response.json({ ok: true, result: { message_id: 1, date: 1 } }));
vi.stubGlobal('fetch', fetchMock);

import {
  sendMessage, sendMessageWithKeyboard, editMessage, editMessageReplyMarkup,
  answerCallbackQuery, pinChatMessage, unpinChatMessage, deleteMessage, sendDocument,
} from '../src/lib/telegram.js';
import { initTestMode, rememberCallback } from '../src/lib/test-mode.js';
import { retireUI, rejectExpiredUI } from '../src/lib/transient-ui.js';

const envOf = ids => ({ TEST_CHAT_IDS: ids, BOT_TOKEN: '1:ABC', SESSIONS: { put: vi.fn(), delete: vi.fn(), get: vi.fn(), list: vi.fn() } });

beforeEach(() => {
  fetchMock.mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const journalLines = () => console.log.mock.calls.map(c => c.join(' ')).filter(l => l.includes('[test-mode]'));

describe('lib/telegram.js — 7 функций + sendMessageWithKeyboard', () => {
  it('тестовый чат: 0 fetch, строка журнала kind=<fn> на каждую отправку', async () => {
    initTestMode(envOf(String(TEST)));
    await sendMessage('1:ABC', TEST, 'привет');
    await editMessage('1:ABC', TEST, 5, 'правка');
    await editMessageReplyMarkup('1:ABC', TEST, 5, []);
    await pinChatMessage('1:ABC', TEST, 5);
    await unpinChatMessage('1:ABC', TEST, 5);
    await deleteMessage('1:ABC', TEST, 5);
    await sendDocument('1:ABC', TEST, 'a.txt', 'body', 'caption');
    expect(fetchMock).not.toHaveBeenCalled();
    const lines = journalLines();
    for (const kind of ['sendMessage', 'editMessage', 'editMessageReplyMarkup', 'pinChatMessage', 'unpinChatMessage', 'deleteMessage', 'sendDocument']) {
      expect(lines.some(l => l.includes(`kind=${kind} chat=${TEST}`)), `нет kind=${kind}`).toBe(true);
    }
  });

  it('обычный чат: fetch вызван как прежде', async () => {
    initTestMode(envOf(String(TEST)));
    const res = await sendMessage('1:ABC', CTRL, 'привет');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
    expect(journalLines()).toHaveLength(0);
  });

  it('sendMessageWithKeyboard: suppressed-результат не доходит до trackUI (нет KV-записи о несуществующем сообщении)', async () => {
    initTestMode(envOf(String(TEST)));
    const lifecycleEnv = { SESSIONS: { put: vi.fn() } };
    const res = await sendMessageWithKeyboard('1:ABC', TEST, 'меню', [[{ text: 'x', callback_data: 'pp:1' }]], {}, lifecycleEnv);
    expect(res.suppressed).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lifecycleEnv.SESSIONS.put).not.toHaveBeenCalled();
    expect(res.result).toBeUndefined();
  });

  it('после выключения (пустой список) — обычные отправки', async () => {
    initTestMode(envOf(''));
    await sendMessage('1:ABC', TEST, 'снова');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('answerCallbackQuery — по реестру callback', () => {
  it('callback из тестового чата подавлен, чужой/незарегистрированный — отвечает', async () => {
    initTestMode(envOf(String(TEST)));
    rememberCallback('cb-test', TEST);
    rememberCallback('cb-ctrl', CTRL);
    await answerCallbackQuery('1:ABC', 'cb-test', 'ок');
    expect(fetchMock).not.toHaveBeenCalled();
    await answerCallbackQuery('1:ABC', 'cb-ctrl', 'ок');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await answerCallbackQuery('1:ABC', 'cb-never-seen', 'ок');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('transient-ui (G4) — retireUI / rejectExpiredUI', () => {
  it('retireUI в тестовом чате: без fetch, в обычном — fetch', async () => {
    initTestMode(envOf(String(TEST)));
    const env = envOf(String(TEST));
    expect(await retireUI(env, TEST, 5)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    // env-scoped гейт: без init, но env знает про тестовый чат
    expect(await retireUI(envOf(String(TEST)), TEST, 5)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await retireUI(envOf(String(TEST)), CTRL, 5)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejectExpiredUI в тестовом чате: логический reject без answerCallbackQuery-сети', async () => {
    initTestMode(envOf(String(TEST)));
    const env = envOf(String(TEST));
    const cq = { id: 'cb1', data: 'pp:1', message: { message_id: 9, date: Math.floor(Date.now() / 1000) - 3600, chat: { id: TEST, type: 'private' } } };
    expect(await rejectExpiredUI(cq, env, {})).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
