import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Quiet-mode group history (src/group-history.js): ambient group messages the bot
// does not act on are kept in the chat's IntakeBuffer DO and reach /run `context`
// when the bot is later addressed. Real DO + real runTask; only IO is faked.

vi.mock('../src/handlers/message.js', () => ({ handleMessage: vi.fn() }));
vi.mock('../src/intake-preflight.js', () => ({ preflight: vi.fn() }));
vi.mock('../src/lib/telegram.js', () => ({
  sendMessage: vi.fn(async () => ({ ok: true, result: { message_id: 1 } })),
  sendDocument: vi.fn(), sendMessageWithKeyboard: vi.fn(), editMessage: vi.fn(),
  editMessageReplyMarkup: vi.fn(), deleteMessage: vi.fn(),
}));

import { IntakeBuffer } from '../src/intake-buffer.js';
import { runTask } from '../src/lib/agent-client.js';
import {
  HISTORY_MAX, HISTORY_TTL_MS, historyEntry, pruneHistory, formatHistoryBlock,
  recordGroupMessage, groupHistoryBlock, setGroupHistoryEnabled,
} from '../src/group-history.js';

function makeState() {
  const map = new Map();
  let alarm = null;
  return {
    storage: {
      async list({ prefix = '' } = {}) { return new Map([...map].filter(([k]) => k.startsWith(prefix))); },
      async get(k) { return map.get(k); },
      async put(k, v) { map.set(k, v); },
      async delete(k) { map.delete(k); },
      async getAlarm() { return alarm; },
      async setAlarm(t) { alarm = t; },
      async deleteAlarm() { alarm = null; },
      async transaction(fn) { return fn(this); },
    },
  };
}

// One real IntakeBuffer per conversation key, like the Workers DO namespace.
function makeEnv() {
  const objects = new Map();
  const env = {
    AGENT_URL: 'https://agent.example', AGENT_SECRET: 's', BOT_TOKEN: 't',
    INTAKE: {
      idFromName: (n) => n,
      get: (id) => {
        if (!objects.has(id)) objects.set(id, new IntakeBuffer(makeState(), env));
        const obj = objects.get(id);
        return { fetch: (u, init) => obj.fetch(new Request(u, init)) };
      },
    },
  };
  return env;
}

const nowSec = () => Math.floor(Date.now() / 1000);
const gmsg = (id, text, over = {}) => ({
  message_id: id, date: nowSec(), chat: { id: -100500, type: 'supergroup' },
  from: { id: id, first_name: 'Петя', username: 'petya' }, text, ...over,
});

describe('pure helpers', () => {
  it('historyEntry keeps author, text, media tag; drops empty', () => {
    expect(historyEntry(gmsg(1, 'привет'))).toMatchObject({ id: 1, from: 'Петя (@petya)', text: 'привет' });
    expect(historyEntry(gmsg(2, undefined, { voice: { file_id: 'v' } })).text).toBe('[голосовое]');
    expect(historyEntry(gmsg(3, undefined, { photo: [{}], caption: 'скрин' })).text).toBe('[фото] скрин');
    expect(historyEntry(gmsg(4, undefined, { sticker: {} }))).toBeNull();
    expect(historyEntry(gmsg(5, 'x'.repeat(5000))).text.length).toBeLessThan(1100);
  });

  it('pruneHistory drops >24h, dedups by message id, caps at HISTORY_MAX', () => {
    const now = Date.now();
    const old = { id: 1, ts: now - HISTORY_TTL_MS - 1, from: 'a', text: 'old' };
    const many = Array.from({ length: HISTORY_MAX + 10 }, (_, i) => ({ id: 100 + i, ts: now - 1000 + i, from: 'a', text: `m${i}` }));
    const kept = pruneHistory([old, ...many, many[5]], now);
    expect(kept).toHaveLength(HISTORY_MAX);
    expect(kept.find(e => e.text === 'old')).toBeUndefined();
    expect(kept.at(-1).text).toBe(`m${HISTORY_MAX + 9}`);
  });

  it('formatHistoryBlock labels the block as non-addressed and keeps order', () => {
    const block = formatHistoryBlock([
      { ts: Date.UTC(2026, 8, 27, 9, 0), from: 'Петя', text: 'первое' },
      { ts: Date.UTC(2026, 8, 27, 9, 5), from: 'Маша', text: 'второе' },
    ]);
    expect(block).toMatch(/История группы/);
    expect(block).toContain('[27.09 12:00 МСК] Петя: первое');
    expect(block.indexOf('первое')).toBeLessThan(block.indexOf('второе'));
    expect(formatHistoryBlock([])).toBe('');
  });
});

describe('ambient group message → DO → /run context', () => {
  let runBodies;
  beforeEach(() => {
    runBodies = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (String(url).endsWith('/run')) runBodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('a task addressed later in the group carries what the group said before', async () => {
    const env = makeEnv();
    await recordGroupMessage(env, gmsg(10, '12345'));
    await recordGroupMessage(env, gmsg(11, '987 — отзыв клиента: форма не грузится'));
    await runTask(env, { userId: -100500, username: 'owner', task: 'что писали выше?' });
    expect(runBodies).toHaveLength(1);
    expect(runBodies[0].context).toContain('12345');
    expect(runBodies[0].context).toContain('987 — отзыв клиента');
    expect(runBodies[0].task).toBe('что писали выше?');
  });

  it('keeps an existing context after the history block', async () => {
    const env = makeEnv();
    await recordGroupMessage(env, gmsg(12, 'контекст группы'));
    await runTask(env, { userId: -100500, username: 'owner', task: 't', context: 'CTX' });
    expect(runBodies[0].context).toMatch(/контекст группы[\s\S]*\n\nCTX$/);
  });

  it('private chats never read group history', async () => {
    const env = makeEnv();
    const spy = vi.spyOn(env.INTAKE, 'get');
    await runTask(env, { userId: 777, username: 'owner', task: 't' });
    expect(spy).not.toHaveBeenCalled();
    expect(runBodies[0].context).toBeUndefined();
  });

  it('forum topics keep separate histories', async () => {
    const env = makeEnv();
    await recordGroupMessage(env, gmsg(13, 'тема A'), 5);
    await recordGroupMessage(env, gmsg(14, 'тема B'), 6);
    const a = await groupHistoryBlock(env, -100500, 5);
    expect(a).toContain('тема A');
    expect(a).not.toContain('тема B');
  });

  it('/history_off stops recording and wipes; /history_on resumes', async () => {
    const env = makeEnv();
    await recordGroupMessage(env, gmsg(15, 'до выключения'));
    expect(await setGroupHistoryEnabled(env, -100500, null, false)).toMatchObject({ wasEnabled: true });
    await recordGroupMessage(env, gmsg(16, 'во время выключения'));
    expect(await groupHistoryBlock(env, -100500)).toBe('');
    expect(await setGroupHistoryEnabled(env, -100500, null, true)).toMatchObject({ wasEnabled: false });
    await recordGroupMessage(env, gmsg(17, 'после включения'));
    const block = await groupHistoryBlock(env, -100500);
    expect(block).toContain('после включения');
    expect(block).not.toContain('до выключения');
    expect(block).not.toContain('во время выключения');
  });

  it('the next run carries only what was said since the previous run (no repeats)', async () => {
    const env = makeEnv();
    await recordGroupMessage(env, gmsg(20, 'старое-1'));
    await recordGroupMessage(env, gmsg(21, 'старое-2'));
    await runTask(env, { userId: -100500, username: 'owner', task: 'первая задача' });
    expect(runBodies[0].context).toContain('старое-1');
    expect(runBodies[0].groupHistory.map(e => e.text)).toEqual(['старое-1', 'старое-2']);

    // Nothing new → the second run gets no history block at all.
    await runTask(env, { userId: -100500, username: 'owner', task: 'вторая задача' });
    expect(runBodies[1].context).toBeUndefined();
    expect(runBodies[1].groupHistory).toBeUndefined();

    // Something new → only the new message, not the delivered ones.
    await recordGroupMessage(env, gmsg(22, 'новое'));
    await runTask(env, { userId: -100500, username: 'owner', task: 'третья задача' });
    expect(runBodies[2].context).toContain('новое');
    expect(runBodies[2].context).not.toContain('старое');
    expect(runBodies[2].groupHistory.map(e => e.text)).toEqual(['новое']);

    // Delivered entries are still kept in the DO (full window), only the cursor moved.
    const res = await env.INTAKE.get('-100500').fetch('https://intake/group-history');
    expect((await res.json()).entries.map(e => e.text)).toEqual(['старое-1', 'старое-2', 'новое']);
  });

  it('a run the agent rejected does not consume the history', async () => {
    const env = makeEnv();
    await recordGroupMessage(env, gmsg(30, 'важное'));
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (String(url).endsWith('/run')) runBodies.push(JSON.parse(init.body));
      return new Response('bad', { status: 400 });
    }));
    await expect(runTask(env, { userId: -100500, username: 'owner', task: 'x' })).rejects.toThrow(/HTTP 400/);
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (String(url).endsWith('/run')) runBodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }));
    await runTask(env, { userId: -100500, username: 'owner', task: 'y' });
    expect(runBodies.at(-1).context).toContain('важное');
  });

  it('forum topics have independent delivery cursors', async () => {
    const env = makeEnv();
    await recordGroupMessage(env, gmsg(40, 'A1'), 5);
    await recordGroupMessage(env, gmsg(41, 'B1'), 6);
    await runTask(env, { userId: -100500, username: 'owner', task: 't', threadId: 5 });
    expect(runBodies[0].context).toContain('A1');
    await runTask(env, { userId: -100500, username: 'owner', task: 't', threadId: 6 });
    expect(runBodies[1].context).toContain('B1');
  });

  it('a broken DO never breaks the run', async () => {
    const env = { AGENT_URL: 'https://agent.example', AGENT_SECRET: 's',
      INTAKE: { idFromName: n => n, get: () => ({ fetch: async () => { throw new Error('boom'); } }) } };
    await runTask(env, { userId: -100500, username: 'owner', task: 't' });
    expect(runBodies[0].task).toBe('t');
    expect(await recordGroupMessage(env, gmsg(18, 'x'))).toBe(false);
  });
});
