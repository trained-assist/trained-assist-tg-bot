import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { conversationKey, deliveryContext, threadExtra, threadIdOf } from '../src/conversation-context.js';
import { getSession, setSession, THREAD_SESSION_FIELDS } from '../src/lib/kv.js';
import { MediaJob } from '../src/media-jobs.js';
import { stopTask } from '../src/lib/agent-client.js';

// Cross-topic (forum) isolation matrix for issue #255.
//
// HARD GUARD under test: with no valid `message_thread_id` every key/payload is
// byte-for-byte the legacy chat-only form. Forum topics get `chatId:threadId`.
const CHAT = -1001234567890;

function makeKV() {
  const map = new Map();
  return {
    map,
    get: async (key, opts) => {
      const v = map.has(key) ? map.get(key) : null;
      if (opts?.type === 'json') return v == null ? null : JSON.parse(v);
      return v == null ? null : v;
    },
    put: async (key, val) => { map.set(key, String(val)); },
    delete: async key => { map.delete(key); },
  };
}

describe('conversation-context', () => {
  it('legacy keys and payloads when no thread', () => {
    expect(conversationKey(CHAT)).toBe(String(CHAT));
    expect(conversationKey(CHAT, 0)).toBe(String(CHAT));
    expect(conversationKey(CHAT, NaN)).toBe(String(CHAT));
    expect(threadExtra(null)).toEqual({});
    expect(threadIdOf({})).toBeNull();
    expect(deliveryContext({ chat: { id: CHAT } })).toEqual({ chatId: CHAT });
  });
  it('topic keys when a valid thread is present', () => {
    expect(conversationKey(CHAT, 7)).toBe(`${CHAT}:7`);
    expect(threadExtra(7)).toEqual({ message_thread_id: 7 });
    expect(deliveryContext({ chat: { id: CHAT }, message_thread_id: 7 })).toEqual({ chatId: CHAT, threadId: 7 });
  });
});

describe('kv session split — chat state vs thread state', () => {
  let kv;
  beforeEach(() => { kv = makeKV(); });

  it('keeps legacy single-record layout when no thread', async () => {
    await setSession(kv, CHAT, { username: 'u', lastSessionId: 's-1', projectId: 'p-1' });
    expect(kv.map.has(String(CHAT))).toBe(true);
    expect([...kv.map.keys()].some(k => k.includes(':'))).toBe(false);
    expect(await getSession(kv, CHAT)).toMatchObject({ username: 'u', lastSessionId: 's-1', projectId: 'p-1' });
  });

  it('scopes dialog/project pointers per topic but shares auth', async () => {
    await setSession(kv, CHAT, { username: 'u', name: 'User', allMsgMode: true });
    await setSession(kv, CHAT, { username: 'u', lastSessionId: 's-A', projectId: 'p-A', pendingProjectChoice: { token: 'A' } }, 11);
    await setSession(kv, CHAT, { username: 'u', lastSessionId: 's-B', projectId: 'p-B', pendingProjectChoice: { token: 'B' } }, 22);

    const a = await getSession(kv, CHAT, 11);
    const b = await getSession(kv, CHAT, 22);
    expect(a).toMatchObject({ username: 'u', allMsgMode: true, lastSessionId: 's-A', projectId: 'p-A' });
    expect(b).toMatchObject({ username: 'u', allMsgMode: true, lastSessionId: 's-B', projectId: 'p-B' });
    expect(a.pendingProjectChoice.token).toBe('A');
    expect(b.pendingProjectChoice.token).toBe('B');

    // Chat-level read never leaks topic pointers.
    const chat = await getSession(kv, CHAT);
    expect(chat).toMatchObject({ username: 'u', allMsgMode: true });
    expect(chat.lastSessionId).toBeUndefined();
    expect(chat.projectId).toBeUndefined();
  });

  it('a thread write never erases auth or a sibling topic', async () => {
    await setSession(kv, CHAT, { username: 'u', allMsgMode: true });
    await setSession(kv, CHAT, { username: 'u', lastSessionId: 's-B' }, 22);
    await setSession(kv, CHAT, { username: 'u', lastSessionId: 's-A' }, 11);
    expect(await getSession(kv, CHAT)).toMatchObject({ username: 'u', allMsgMode: true });
    expect((await getSession(kv, CHAT, 22)).lastSessionId).toBe('s-B');
    expect((await getSession(kv, CHAT, 11)).lastSessionId).toBe('s-A');
  });

  it('every known thread pointer is classified thread-scoped', () => {
    for (const f of ['lastSessionId', 'activeSessionId', 'projectId', 'pendingProjectChoice', 'pendingSupplementDraft', 'pinnedMsgId']) {
      expect(THREAD_SESSION_FIELDS.has(f)).toBe(true);
    }
    for (const f of ['username', 'allMsgMode', 'telegramUserId', 'name']) {
      expect(THREAD_SESSION_FIELDS.has(f)).toBe(false);
    }
  });
});

// ── MediaJob return route ─────────────────────────────────────────────────────
function mediaJobEnv(captured) {
  return {
    INTAKE: {
      idFromName: name => { captured.push(name); return name; },
      get: () => ({ fetch: async () => Response.json({ accepted: true }) }),
    },
  };
}
function mediaJobState(job) {
  const store = { job: { ...job } };
  return {
    storage: {
      get: async k => (k === 'job' ? store.job : null),
      put: async (k, v) => { store[k] = v; },
      transaction: async fn => fn({ get: async k => store[k], put: async (k, v) => { store[k] = v; }, deleteAlarm: async () => {} }),
      setAlarm: async () => {},
      deleteAlarm: async () => {},
      getAlarm: async () => null,
    },
  };
}
const deliverJob = msg => ({ id: 'a'.repeat(64), username: 'u', stage: 'deliver', attempts: 0, msg,
  fileRef: { storage: 'r2', version: 1, id: 'a'.repeat(64), name: 'f', mime: 'text/plain' } });

describe('MediaJob media-result returns to the originating topic', () => {
  it('uses chatId:threadId for a topic message', async () => {
    const captured = [];
    const job = new MediaJob(mediaJobState(deliverJob({ chat: { id: CHAT }, message_id: 5, message_thread_id: 9 })), mediaJobEnv(captured));
    await job.alarm();
    expect(captured).toEqual([`${CHAT}:9`]);
  });
  it('uses the legacy chat key when there is no thread', async () => {
    const captured = [];
    const job = new MediaJob(mediaJobState(deliverJob({ chat: { id: CHAT }, message_id: 5 })), mediaJobEnv(captured));
    await job.alarm();
    expect(captured).toEqual([String(CHAT)]);
  });
});

// ── /stop scoping ─────────────────────────────────────────────────────────────
// A forum topic's stop must be scoped to chat + topic + this bot's audience, while a
// non-forum stop must keep the exact legacy `{ username }` payload (hard guard).
describe('stopTask payload scoping', () => {
  const env = { AGENT_URL: 'https://agent', AGENT_SECRET: 's', SESSION_NAMESPACE: 'recruiter' };
  let originalFetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  function captureBody() {
    let sent = null;
    global.fetch = vi.fn(async (_url, opts) => { sent = JSON.parse(opts.body); return { ok: true, json: async () => ({ ok: true, killed: 1 }) }; });
    return () => sent;
  }

  it('legacy { username } for a private/non-forum stop', async () => {
    const get = captureBody();
    await stopTask(env, { username: 'u', chatId: CHAT, threadId: null });
    expect(get()).toEqual({ username: 'u' });
  });

  it('scopes by chat + topic + audience inside a forum topic', async () => {
    const get = captureBody();
    await stopTask(env, { username: 'u', chatId: CHAT, threadId: 7 });
    expect(get()).toEqual({ username: 'u', chatId: CHAT, threadId: 7, audience: 'recruiter' });
  });
});
