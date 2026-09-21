import { describe, it, expect, vi, beforeEach } from 'vitest';

// Intake invariant harness (issue #66). One executable spec for the rule that keeps
// breaking on new message types/paths (#530 «стартует сразу», #65 групповой путь):
//
//   INVARIANT: no incoming message type launches a session until the user explicitly
//   taps ▶️ / types a bare force-word. Until then everything ACCUMULATES.
//
// These tests drive the REAL routeText with a mocked INTAKE stub + mocked handleMessage,
// so a session "launch" == handleMessage being called. `_appended` is the buffer.
//
// The photo/document cases are marked it.fails: they encode the DESIRED behaviour
// (media must buffer) which the current funnel does NOT satisfy — `shouldDebounce`
// bypasses on `!text` (src/index.js) and `_dispatch` coalesces only `.text`
// (src/intake-buffer.js). When part B of #66 lands, drop `.fails` and they pass.

const handleMessage = vi.fn();
vi.mock('../src/handlers/message.js', () => ({ handleMessage: (...a) => handleMessage(...a) }));
vi.mock('../src/handlers/commands.js', () => ({ handleCommand: vi.fn(), isAdminForwardedCommand: () => false }));
vi.mock('../src/handlers/user-mgmt.js', () => ({ handleUserMgmt: vi.fn(), isUserMgmtCommand: () => false }));
vi.mock('../src/handlers/callbacks.js', () => ({ handleCallbackQuery: vi.fn() }));
vi.mock('../src/lib/kv.js', () => ({ getSession: vi.fn(), getOrCreateMappedSession: vi.fn() }));
vi.mock('../src/lib/telegram.js', () => ({ sendMessage: vi.fn() }));

import { routeText } from '../src/index.js';

function makeEnv() {
  const appended = [];
  const stub = { fetch: vi.fn(async (_url, init) => { appended.push(JSON.parse(init.body)); return new Response('{}'); }) };
  return {
    _appended: appended,
    env: { INTAKE_DEBOUNCE: 'on', BOT_TOKEN: 't', INTAKE: { idFromName: n => n, get: () => stub } },
  };
}

// Static Telegram-update fixtures — the "staging mocks" from the requirement.
const CHAT = { id: 42 };
const fx = {
  text:     { chat: CHAT, text: 'быстрая мысль' },
  forceWord:{ chat: CHAT, text: 'го' },
  prose:    { chat: CHAT, text: 'давай сделаем разбор' },
  reply:    { chat: CHAT, text: 'да', reply_to_message: { message_id: 1 } },
  photo:    { chat: CHAT, photo: [{ file_id: 'ph1' }], caption: '' },
  document: { chat: CHAT, document: { file_id: 'doc1', file_name: 'a.pdf' } },
};

beforeEach(() => handleMessage.mockClear());

describe('intake invariant — a message must ACCUMULATE, not launch (issue #66)', () => {
  it('text: buffers, does not launch', async () => {
    const { env, _appended } = makeEnv();
    await routeText(fx.text, env, 42);
    expect(handleMessage).not.toHaveBeenCalled();
    expect(_appended).toHaveLength(1);
  });

  it('bare force-word: flushes the buffer immediately', async () => {
    const { env, _appended } = makeEnv();
    await routeText(fx.forceWord, env, 42);
    expect(_appended[0].flush).toBe(true);
  });

  it('prose containing a force-ish word: does NOT flush', async () => {
    const { env, _appended } = makeEnv();
    await routeText(fx.prose, env, 42);
    expect(_appended[0].flush).toBe(false);
  });

  // A reply can be the first part of a mixed-media continuation.
  it('reply-to-bot: buffers before launch', async () => {
    const { env, _appended } = makeEnv();
    await routeText(fx.reply, env, 42);
    expect(_appended).toHaveLength(1);
    expect(handleMessage).not.toHaveBeenCalled();
  });

  // ---- Part B of #66 landed: media now buffers instead of firing. ----
  it('photo: buffers, does not launch', async () => {
    const { env, _appended } = makeEnv();
    await routeText(fx.photo, env, 42);
    expect(handleMessage).not.toHaveBeenCalled();
    expect(_appended).toHaveLength(1);
  });

  it('document: buffers, does not launch', async () => {
    const { env, _appended } = makeEnv();
    await routeText(fx.document, env, 42);
    expect(handleMessage).not.toHaveBeenCalled();
    expect(_appended).toHaveLength(1);
  });
});
