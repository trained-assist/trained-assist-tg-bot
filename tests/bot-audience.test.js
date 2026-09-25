import { describe, it, expect, vi, afterEach } from 'vitest';
import worker from '../src/index.js';
import { applySessionNamespace } from '../src/lib/session-namespace.js';
import { isCommandVisible } from '../src/lib/command-visibility.js';
import { registerBotCommands } from '../src/lib/telegram.js';
import commandsRegistry from '../commands-registry.json';

// Issue #1302 §4.5: the third bot must be isolated from the other two on three
// axes — KV key space, command visibility, and webhook ingress. These tests pin
// each axis so a future env addition can't silently mix bots.

afterEach(() => vi.unstubAllGlobals());

// ── KV namespace isolation ─────────────────────────────────────────────────
function fakeKv() {
  const store = new Map();
  return {
    store,
    get: vi.fn(async (k) => store.get(k)),
    put: vi.fn(async (k, v) => { store.set(k, v); }),
    delete: vi.fn(async (k) => { store.delete(k); }),
    list: vi.fn(async (opts = {}) => ({
      keys: [...store.keys()].filter((k) => k.startsWith(opts.prefix || '')).map((name) => ({ name })),
      list_complete: true,
    })),
  };
}

describe('applySessionNamespace isolates a bot KV key space', () => {
  it('prefixes get/put/delete so two bots sharing one KV never collide', async () => {
    const raw = fakeKv();
    const freelance = applySessionNamespace({ SESSION_NAMESPACE: 'freelance', SESSIONS: raw });
    const main = { SESSION_NAMESPACE: undefined, SESSIONS: raw };

    await main.SESSIONS.put('chat:1', 'main-session');
    await freelance.SESSIONS.put('chat:1', 'freelance-session');

    expect(raw.store.get('chat:1')).toBe('main-session');
    expect(raw.store.get('freelance:chat:1')).toBe('freelance-session');
    expect(await freelance.SESSIONS.get('chat:1')).toBe('freelance-session');
    expect(await main.SESSIONS.get('chat:1')).toBe('main-session');

    await freelance.SESSIONS.delete('chat:1');
    expect(raw.store.has('freelance:chat:1')).toBe(false);
    expect(raw.store.get('chat:1')).toBe('main-session');
  });

  it('is idempotent — applying twice never yields recruiter:recruiter: keys', async () => {
    const raw = fakeKv();
    const once = applySessionNamespace({ SESSION_NAMESPACE: 'recruiter', SESSIONS: raw });
    const twice = applySessionNamespace(once);
    await twice.SESSIONS.put('chat:2', 'x');
    expect([...raw.store.keys()]).toEqual(['recruiter:chat:2']);
    expect(await twice.SESSIONS.get('chat:2')).toBe('x');
  });

  it('prefixes list() too (the old inline wrapper left it un-prefixed)', async () => {
    const raw = fakeKv();
    const wrapped = applySessionNamespace({ SESSION_NAMESPACE: 'freelance', SESSIONS: raw });
    await wrapped.SESSIONS.put('a:1', 'x');
    await wrapped.SESSIONS.put('b:2', 'y');
    const page = await wrapped.SESSIONS.list({ prefix: 'a:' });
    expect(raw.list).toHaveBeenCalledWith({ prefix: 'freelance:a:' });
    expect(page.keys.map((k) => k.name)).toEqual(['freelance:a:1']);
  });

  it('leaves a bot without SESSION_NAMESPACE on raw keys', async () => {
    const raw = fakeKv();
    const main = applySessionNamespace({ SESSIONS: raw });
    await main.SESSIONS.put('chat:3', 'v');
    expect(raw.store.has('chat:3')).toBe(true);
  });
});

// ── Command visibility ─────────────────────────────────────────────────────
const entry = (command) => commandsRegistry.commands.find((c) => c.command === command);

describe('command visibility is audience-aware', () => {
  it('freelance sees general commands but not recruiter-only HH commands', () => {
    expect(isCommandVisible(entry('/persona'), 'freelance')).toBe(true);
    expect(isCommandVisible(entry('/settoken'), 'freelance')).toBe(true);
    expect(isCommandVisible(entry('/hh_status'), 'freelance')).toBe(false);
  });

  it('recruiter sees HH commands but not recruiter-hidden dev/ops commands', () => {
    expect(isCommandVisible(entry('/hh_status'), 'recruiter')).toBe(true);
    expect(isCommandVisible(entry('/settoken'), 'recruiter')).toBe(false);
  });

  it('default sees general commands but not HH commands', () => {
    expect(isCommandVisible(entry('/persona'), 'default')).toBe(true);
    expect(isCommandVisible(entry('/hh_status'), 'default')).toBe(false);
  });

  it('hidden and adminOnly entries are never visible', () => {
    expect(isCommandVisible({ hidden: true, audiences: ['freelance'] }, 'freelance')).toBe(false);
    expect(isCommandVisible({ adminOnly: true, audiences: ['default'] }, 'default')).toBe(false);
  });
});

describe('registerBotCommands honours the freelance profile', () => {
  it('omits HH commands, includes general ones', async () => {
    let sent;
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      sent = JSON.parse(opts.body).commands;
      return Response.json({ ok: true });
    }));
    await registerBotCommands('tok', { audience: 'freelance' });
    expect(sent.some((c) => c.command === 'hh_status')).toBe(false);
    expect(sent.some((c) => c.command === 'persona')).toBe(true);
    expect(sent.some((c) => c.command === 'settoken')).toBe(true);
  });
});

// ── Webhook secret ─────────────────────────────────────────────────────────
function webhookRequest(secretHeader) {
  const headers = { 'content-type': 'application/json' };
  if (secretHeader !== undefined) headers['X-Telegram-Bot-Api-Secret-Token'] = secretHeader;
  return new Request('https://worker/webhook', { method: 'POST', headers, body: '{}' });
}

describe('webhook secret is validated before any state change', () => {
  it('rejects a missing or wrong secret without dispatching', async () => {
    const env = { TELEGRAM_WEBHOOK_SECRET: 's3cret' };
    for (const header of [undefined, 'wrong']) {
      const waitUntil = vi.fn();
      const res = await worker.fetch(webhookRequest(header), env, { waitUntil });
      expect(res.status).toBe(401);
      expect(waitUntil).not.toHaveBeenCalled();
    }
  });

  it('accepts a matching secret and dispatches', async () => {
    const env = { TELEGRAM_WEBHOOK_SECRET: 's3cret' };
    const waitUntil = vi.fn();
    const res = await worker.fetch(webhookRequest('s3cret'), env, { waitUntil });
    expect(res.status).toBe(200);
    expect(waitUntil).toHaveBeenCalled();
  });

  it('fails closed when no secret is configured (no unsigned updates, ever)', async () => {
    const env = {};
    for (const header of [undefined, 'anything']) {
      const waitUntil = vi.fn();
      const res = await worker.fetch(webhookRequest(header), env, { waitUntil });
      expect(res.status).toBe(401);
      expect(waitUntil).not.toHaveBeenCalled();
    }
  });
});
