import { describe, expect, it, vi } from 'vitest';
import { buildSync } from 'esbuild';
import { Miniflare } from 'miniflare';
import worker from '../src/index.js';

function request(update) {
  return new Request('https://worker.test/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'hook-secret' },
    body: JSON.stringify(update),
  });
}

function env(inboxFetch) {
  const stub = { fetch: vi.fn(inboxFetch) };
  return {
    BOT_TOKEN: 'test-token', BOT_USERNAME: 'super_personal_assistant_bot',
    TELEGRAM_WEBHOOK_SECRET: 'hook-secret', AGENT_SECRET: 'agent-secret',
    SANDBOX_REQUIRE_CHAT_ALLOWLIST: 'true', SANDBOX_ALLOWED_CHAT_IDS: '1714048',
    SESSIONS: { get: vi.fn(async () => null), put: vi.fn(async () => {}), delete: vi.fn(async () => {}) },
    TELEGRAM_UPDATE_INBOX: { idFromName: vi.fn(name => name), get: vi.fn(() => stub) },
    stub,
  };
}

const ordinary = { update_id: 57, message: { message_id: 91,
  from: { id: 1714048, is_bot: false }, chat: { id: 1714048, type: 'private' }, text: 'continue task' } };

describe('production webhook durable admission', () => {
  it('returns 200 only after the inbox durably accepts an ordinary message', async () => {
    const target = env(async (_request) => Response.json({ accepted: true, state: 'queued', updateId: 57 }, { status: 202 }));
    const waitUntil = vi.fn();
    const response = await worker.fetch(request(ordinary), target, { waitUntil });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, accepted: true, state: 'queued' });
    expect(target.TELEGRAM_UPDATE_INBOX.idFromName).toHaveBeenCalledWith('super_personal_assistant_bot:1714048:');
    expect(target.stub.fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(target.stub.fetch.mock.calls[0][1].body)).toEqual({ updateId: 57, update: ordinary });
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('runs the admitted envelope through SQLite-backed alarm recovery in workerd', async () => {
    const code = buildSync({ entryPoints: ['src/index.js'], bundle: true, write: false,
      format: 'esm', platform: 'browser', external: ['node:buffer'] }).outputFiles[0].text;
    const runtime = new Miniflare({ modules: true, script: code, compatibilityDate: '2024-01-01',
      compatibilityFlags: ['nodejs_compat'], bindings: {
        BOT_TOKEN: 'test-token', BOT_USERNAME: 'super_personal_assistant_bot',
        TELEGRAM_WEBHOOK_SECRET: 'hook-secret', LIFECYCLE_LOGS: 'true',
      }, durableObjects: { TELEGRAM_UPDATE_INBOX: { className: 'TelegramUpdateInbox', useSQLite: true } },
    });
    try {
      const update = { update_id: 237, message: { message_id: 901, date: Math.floor(Date.now() / 1000) - 3600,
        from: { id: 1714048, is_bot: false }, chat: { id: 1714048, type: 'private' }, text: 'old test update' } };
      const submit = () => runtime.dispatchFetch('https://worker.test/webhook', {
        method: 'POST', headers: { 'content-type': 'application/json',
          'x-telegram-bot-api-secret-token': 'hook-secret' }, body: JSON.stringify(update),
      });
      const responses = await Promise.all([submit(), submit()]);
      expect(responses.map(response => response.status)).toEqual([200, 200]);
      const bodies = await Promise.all(responses.map(response => response.json()));
      expect(bodies.filter(body => body.accepted && !body.duplicate)).toHaveLength(1);
      expect(bodies.filter(body => body.accepted && body.duplicate)).toHaveLength(1);

      const namespace = await runtime.getDurableObjectNamespace('TELEGRAM_UPDATE_INBOX');
      const inboxId = namespace.idFromName('super_personal_assistant_bot:1714048:');
      const status = await namespace.get(inboxId).fetch('https://inbox/status');
      await vi.waitFor(async () => {
        const current = await (await namespace.get(inboxId).fetch('https://inbox/status')).json();
        expect(current.updates).toMatchObject([{ updateId: 237, state: 'complete', attempts: 1 }]);
      }, { timeout: 5000, interval: 20 });
      expect(await status.json()).toMatchObject({ updates: [{ updateId: 237 }] });
    } finally {
      await runtime.dispose();
    }
  }, 15000);

  it('does not ACK when durable admission fails, allowing Telegram to retry', async () => {
    const target = env(async () => new Response('storage unavailable', { status: 503 }));
    const response = await worker.fetch(request(ordinary), target, { waitUntil: vi.fn() });
    expect(response.status).toBe(503);
  });

  it('keeps slash commands on the existing handler path until command effects are replay-safe', async () => {
    const target = env(async () => { throw new Error('must not enqueue command'); });
    const waitUntil = vi.fn();
    const response = await worker.fetch(request({ ...ordinary, message: { ...ordinary.message, text: '/help' } }),
      target, { waitUntil });
    expect(response.status).toBe(200);
    expect(target.stub.fetch).not.toHaveBeenCalled();
    expect(waitUntil).toHaveBeenCalledOnce();
  });
});
