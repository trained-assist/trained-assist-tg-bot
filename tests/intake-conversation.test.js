import { describe, it, expect, vi, beforeEach } from 'vitest';

// End-to-end intake CONVERSATIONS (3–10 messages) against the REAL routing +
// the REAL IntakeBuffer Durable Object. Nothing about the accumulate/launch
// design is re-invented here — we drive the shipped code and assert the full
// Telegram envelope the user would actually see: text AND buttons (per the
// «мокать надо и кнопки» requirement), plus whether each user turn produced any
// visible signal at all. The headline invariant is the anti-«молчит» rule:
//   → every user message during intake must produce a user-visible envelope.
// A message swallowed in silence (the busy-hold path) is the bug we reproduce
// and then close.

// ---- record the real TG envelope every gateway send/edit would emit ----
const tg = [];                 // { kind:'send'|'edit', chatId, text, buttons:[callback_data...] }
const handleMessage = vi.fn(); // the agent dispatch (deep launch); stubbed
let _mid = 100;
const nextId = () => ++_mid;

const kb = (inlineKeyboard) =>
  Array.isArray(inlineKeyboard)
    ? inlineKeyboard.flat().map(b => b.callback_data).filter(Boolean)
    : [];

vi.mock('../src/handlers/message.js', () => ({ handleMessage: (...a) => handleMessage(...a) }));
vi.mock('../src/handlers/commands.js', () => ({ handleCommand: vi.fn(), isAdminForwardedCommand: () => false }));
vi.mock('../src/handlers/user-mgmt.js', () => ({ handleUserMgmt: vi.fn(), isUserMgmtCommand: () => false }));
vi.mock('../src/handlers/callbacks.js', () => ({ handleCallbackQuery: vi.fn() }));
vi.mock('../src/lib/kv.js', () => ({ getSession: vi.fn(), getOrCreateMappedSession: vi.fn() }));
vi.mock('../src/lib/telegram.js', () => ({
  sendMessage: vi.fn((_t, chatId, text, extra = {}) => {
    tg.push({ kind: 'send', chatId, text, buttons: kb(extra?.reply_markup?.inline_keyboard) });
    return Promise.resolve({ ok: true, result: { message_id: nextId() } });
  }),
  sendMessageWithKeyboard: vi.fn((_t, chatId, text, inlineKeyboard) => {
    tg.push({ kind: 'send', chatId, text, buttons: kb(inlineKeyboard) });
    return Promise.resolve({ ok: true, result: { message_id: nextId() } });
  }),
  editMessage: vi.fn((_t, chatId, msgId, text, extra = {}) => {
    tg.push({ kind: 'edit', chatId, msgId, text, buttons: kb(extra?.reply_markup?.inline_keyboard) });
    return Promise.resolve({ ok: true });
  }),
  editMessageReplyMarkup: vi.fn((_t, chatId, msgId, inlineKeyboard = []) => {
    tg.push({ kind: 'edit', chatId, msgId, buttons: kb(inlineKeyboard) });
    return Promise.resolve({ ok: true });
  }),
  sendDocument: vi.fn(() => Promise.resolve({ ok: true, result: { message_id: nextId() } })),
  deleteMessage: vi.fn((_t, chatId, msgId) => {
    tg.push({ kind: 'delete', chatId, msgId });
    return Promise.resolve({ ok: true });
  }),
}));

import { routeText } from '../src/index.js';
import { IntakeBuffer } from '../src/intake-buffer.js';

// Minimal in-memory DurableObjectState (one per chat).
function makeState() {
  const map = new Map();
  let alarm = null;
  return {
    storage: {
      async get(k) { return map.has(k) ? map.get(k) : undefined; },
      async put(k, v) { map.set(k, v); },
      async delete(k) { map.delete(k); },
      async getAlarm() { return alarm; },
      async setAlarm(t) { alarm = t; },
      async deleteAlarm() { alarm = null; },
    },
  };
}

// A world = the gateway env wired to REAL per-chat IntakeBuffer instances.
function makeWorld() {
  const buffers = new Map();
  const env = {
    INTAKE_DEBOUNCE: 'on',
    BOT_TOKEN: 't',
    INTAKE: {
      idFromName: (n) => n,
      get: (name) => {
        if (!buffers.has(name)) buffers.set(name, new IntakeBuffer(makeState(), env));
        const io = buffers.get(name);
        return { fetch: (url, init) => io.fetch(new Request(url, init)) };
      },
    },
  };
  return { env };
}

// Let the dynamic import() inside _dispatch settle across a few macrotasks.
const drain = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)); };

// --- user actions, exactly as the gateway would route them ---
async function say(env, chatId, text) {          // a plain user message
  await routeText({ chat: { id: chatId }, text }, env, chatId);
  await drain();
}
async function replyToBot(env, chatId, text) {   // answering the bot's message
  await routeText({ chat: { id: chatId }, text, reply_to_message: { message_id: 1 } }, env, chatId);
  await drain();
}
function tapRun(env, chatId) {                    // ▶️ Запустить — the intake_run callback
  return env.INTAKE.get(String(chatId)).fetch('https://intake/flush', { method: 'POST' });
}

// How many envelopes were emitted since a recorded mark.
const since = (mark) => tg.slice(mark);
const RUN_CB = 'intake_run';

beforeEach(() => {
  tg.length = 0;
  handleMessage.mockReset();
  handleMessage.mockResolvedValue({ ok: true });
});

describe('intake conversation — real routeText + real IntakeBuffer', () => {
  it('C1: a 5-message task build accumulates visibly, then ▶️ launches ONE deep run', async () => {
    const { env } = makeWorld();
    const parts = [
      'Нужен разбор вакансии senior backend',
      'стек: Go, Postgres, Kafka',
      'зарплата до 400к',
      'удалёнка, но раз в месяц офис',
      'оцени по нашим критериям ATS',
    ];
    for (const p of parts) {
      const mark = tg.length;
      await say(env, 42, p);
      expect(since(mark).length).toBeGreaterThan(0);          // never silent
    }
    // The collector always carries the launch button.
    expect(tg.some(e => e.buttons.includes(RUN_CB))).toBe(true);
    expect(handleMessage).not.toHaveBeenCalled();             // nothing auto-fires

    await tapRun(env, 42);
    await drain();

    expect(handleMessage).toHaveBeenCalledTimes(1);
    const [msg, , opts] = handleMessage.mock.calls[0];
    expect(msg.text).toBe(parts.join('\n'));                  // all 5 coalesced, in order
    expect(opts).toEqual({ mode: 'deep', initialMsgId: expect.any(Number) });
  });

  it('C2: a question sent WHILE a run is in flight must not be swallowed (anti-«молчит»)', async () => {
    const { env } = makeWorld();

    // Start a run and hold it open (isolate still working).
    let release;
    handleMessage.mockReturnValueOnce(new Promise(r => { release = r; }));
    await say(env, 42, 'запусти большую проработку рынка');
    const running = tapRun(env, 42);
    await drain();
    expect(handleMessage).toHaveBeenCalledTimes(1);

    // User checks in mid-run. This is the exact «спросил "работает" — молчит» case.
    const mark = tg.length;
    await say(env, 42, 'работает?');
    expect(since(mark).length).toBeGreaterThan(0);            // <-- the bug: currently 0

    release();
    await running;
    await drain();
  });

  it('C3: a force word mid-conversation launches the accumulated buffer', async () => {
    const { env } = makeWorld();
    await say(env, 42, 'собери участников выставки Rosupack');
    await say(env, 42, 'только российские производители упаковки');
    await say(env, 42, 'го');                                 // bare force word → flush now
    await drain();

    expect(handleMessage).toHaveBeenCalledTimes(1);
    const [msg, , opts] = handleMessage.mock.calls[0];
    expect(msg.text).toContain('собери участников выставки Rosupack');
    expect(msg.text).toContain('только российские производители упаковки');
    expect(opts).toEqual({ mode: 'deep', initialMsgId: expect.any(Number) });
  });

  it('C4: voice reply plus photo and pasted text wait for one explicit launch', async () => {
    const { env } = makeWorld();
    for (const msg of [
      { message_id: 10, voice: { file_id: 'voice-1' }, reply_to_message: { message_id: 1 } },
      { message_id: 11, photo: [{ file_id: 'photo-1' }] },
      { message_id: 12, text: 'скопированный текст' },
    ]) await routeText({ chat: { id: 42 }, ...msg }, env, 42);
    expect(handleMessage).not.toHaveBeenCalled();
    expect(tg.some(e => e.buttons.includes(RUN_CB))).toBe(true);
    await tapRun(env, 42);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    const batch = handleMessage.mock.calls[0][0].intakeItems;
    expect(batch).toHaveLength(3);
    expect(batch[0].msg.voice.file_id).toBe('voice-1');
    expect(batch[0].msg.reply_to_message.message_id).toBe(1);
    expect(batch[1].msg.photo[0].file_id).toBe('photo-1');
    expect(batch[2].text).toBe('скопированный текст');
  });

  it('C5: an 8-message conversation — accumulate, launch, follow-ups held+acked, re-launch', async () => {
    const { env } = makeWorld();

    // 1–3: build and launch the first task; hold the run open.
    let release1;
    handleMessage.mockReturnValueOnce(new Promise(r => { release1 = r; }));
    await say(env, 42, 'проанализируй отклики на вакансию');
    await say(env, 42, 'вакансия — продакт-менеджер');
    await say(env, 42, 'сделай короткий отчёт');
    const run1 = tapRun(env, 42);
    await drain();
    expect(handleMessage).toHaveBeenCalledTimes(1);

    // 4–5: follow-ups arrive mid-run — must be visibly acknowledged, never auto-run.
    for (const p of ['и добавь зарплатные вилки', 'и топ-3 кандидата']) {
      const mark = tg.length;
      await say(env, 42, p);
      expect(since(mark).length).toBeGreaterThan(0);          // no silence during busy
    }
    expect(handleMessage).toHaveBeenCalledTimes(1);           // held, not dispatched

    // Run 1 finishes → a fresh launch button is re-offered for the held messages.
    release1();
    await run1;
    await drain();
    expect(tg.some(e => e.buttons.includes(RUN_CB))).toBe(true);

    // 6: launch the held follow-ups as a second deep run.
    await tapRun(env, 42);
    await drain();
    expect(handleMessage).toHaveBeenCalledTimes(2);
    expect(handleMessage.mock.calls[1][0].text)
      .toBe('и добавь зарплатные вилки\nи топ-3 кандидата');
    expect(handleMessage.mock.calls[1][2]).toEqual({ mode: 'deep', initialMsgId: expect.any(Number) });
  });

  // Regression: a follow-up reply must offer time to add supporting material.
  it('C6: after the agent responded, a follow-up must be CONFIRMED («это всё, или дополнишь?»), not auto-launched', async () => {
    // The user's rationale: Telegram can't carry a comment + an explaining
    // screenshot in one message. So after the agent answers, the very next
    // contribution is usually the SECOND half of one thought — it must be held
    // and the bot must ask «это всё, или ещё дополнишь?» (offering ▶️), never
    // fire on its own. This is the class behind «ответил Б → сразу побежал».
    const { env } = makeWorld();

    // Turn 1: build + launch. The run completing == «the agent responded».
    await say(env, 42, 'разбери отклик кандидата Иванова');
    await tapRun(env, 42);
    await drain();
    expect(handleMessage).toHaveBeenCalledTimes(1);          // one run so far

    // The user now adds the second half of the same thought (a reply to the
    // bot's answer — exactly «юзер ему отвечает»). It must NOT dispatch; it must
    // surface a confirmation carrying the launch button.
    const mark = tg.length;
    await replyToBot(env, 42, 'вот скриншот его теста — учти его тоже');

    const emitted = since(mark);
    expect(emitted.length).toBeGreaterThan(0);               // never silent
    expect(emitted.some(e => e.buttons.includes(RUN_CB))).toBe(true); // «▶️» offered
    expect(emitted.some(e => /это всё|дополн/i.test(e.text || ''))).toBe(true); // asks
    expect(handleMessage).toHaveBeenCalledTimes(1);          // <-- current bug: fires 2nd run
  });
});
