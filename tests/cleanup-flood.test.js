import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/lib/agent-client.js', () => ({
  getAgentHealth: vi.fn(),
  getSessions: vi.fn(),
  getFiles: vi.fn(),
  runTask: vi.fn(),
  getSkills: vi.fn(),
  stopTask: vi.fn(),
  reportBugOrFeature: vi.fn(),
  setUserToken: vi.fn(),
}));
vi.mock('../src/lib/telegram.js', () => ({
  sendMessage: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } }),
  sendMessageWithKeyboard: vi.fn().mockResolvedValue({ ok: true }),
  pinChatMessage: vi.fn(),
  unpinChatMessage: vi.fn(),
  deleteMessage: vi.fn(),
}));
vi.mock('../src/lib/kv.js', () => ({
  getSession: vi.fn(),
  setSession: vi.fn(),
  deleteSession: vi.fn(),
  newSessionId: () => 's-1',
  getUser: vi.fn(),
  listUsernames: vi.fn().mockResolvedValue([]),
}));
vi.mock('../src/handlers/message.js', () => ({ handleMessage: vi.fn() }));

import { handleCommand } from '../src/handlers/commands.js';
import { sendMessage } from '../src/lib/telegram.js';
import { getSession } from '../src/lib/kv.js';

function env(sentIds = []) {
  return {
    BOT_TOKEN: 't',
    AGENT_URL: 'https://agent',
    AGENT_SECRET: 'secret',
    SESSIONS: {
      get: vi.fn(async () => (sentIds.length ? JSON.stringify(sentIds) : null)),
      delete: vi.fn(async () => {}),
    },
  };
}
const msg = (chatId) => ({ chat: { id: chatId }, text: '/clean_up_flood', from: { id: chatId } });

afterEach(() => vi.unstubAllGlobals());

describe('/clean_up_flood', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSession.mockResolvedValue({ username: 'u' });
  });

  it('deletes agent + gateway text and reports the combined counts', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url);
      if (u.endsWith('/cleanup-flood')) return { ok: true, json: async () => ({ deleted: 5, failed: 0 }) };
      if (u.includes('/deleteMessages')) return { ok: true, json: async () => ({ ok: true }) };
      return { ok: false, json: async () => ({}) };
    }));

    await handleCommand(msg(1), env([10, 11]));

    const text = sendMessage.mock.calls[0][2];
    expect(text).toMatch(/Удалил: <b>7<\/b>/);
    expect(text).toMatch(/Не смог: <b>0<\/b>/);
  });

  it('still cleans the gateway side when the agent is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url);
      if (u.endsWith('/cleanup-flood')) throw new Error('down');
      if (u.includes('/deleteMessages')) return { ok: true, json: async () => ({ ok: true }) };
      return { ok: false, json: async () => ({}) };
    }));

    await handleCommand(msg(2), env([5]));

    const text = sendMessage.mock.calls[0][2];
    expect(text).toMatch(/Удалил: <b>1<\/b>/);
    expect(text).toMatch(/Агент был недоступен/);
  });

  it('counts per-id failures instead of hiding them', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url);
      if (u.endsWith('/cleanup-flood')) return { ok: true, json: async () => ({ deleted: 1, failed: 2 }) };
      // deleteMessages rejected → per-id fallback also rejects.
      return { ok: false, json: async () => ({ ok: false }) };
    }));

    await handleCommand(msg(3), env([9]));

    const text = sendMessage.mock.calls[0][2];
    expect(text).toMatch(/Удалил: <b>1<\/b>/);
    expect(text).toMatch(/Не смог: <b>3<\/b>/);
  });

  it('asks to log in and does nothing without a session', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    getSession.mockResolvedValueOnce(null);

    await handleCommand(msg(4), env([]));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalled();
  });
});
