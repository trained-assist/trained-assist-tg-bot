import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach } from 'vitest';
import worker from '../src/index.js';

const fetchSpy = vi.spyOn(globalThis, 'fetch');
const logSpy = vi.spyOn(console, 'log');
beforeEach(() => { fetchSpy.mockReset(); logSpy.mockClear(); });
afterEach(() => { fetchSpy.mockReset(); logSpy.mockClear(); });

function signedWebhook(update, env, secret = 'test-webhook-secret') {
  const promises = [];
  const request = new Request('https://sandbox.test/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': secret,
    },
    body: JSON.stringify(update),
  });
  return worker.fetch(request, env, { waitUntil: promise => promises.push(promise) })
    .then(response => ({ response, promises }));
}

const update = chatId => ({
  update_id: 77,
  message: {
    message_id: 1,
    date: Math.floor(Date.now() / 1000),
    chat: { id: chatId, type: 'private' },
    from: { id: chatId, is_bot: false, first_name: 'Sandbox Tester' },
    text: '/start',
  },
});

describe('sales sandbox ingress allowlist', () => {
  const env = allowedChatIds => ({
    BOT_USERNAME: 'flexi_leads_bot',
    SESSION_NAMESPACE: 'sales',
    TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret',
    SANDBOX_REQUIRE_CHAT_ALLOWLIST: 'true',
    SANDBOX_ALLOWED_CHAT_IDS: allowedChatIds,
    TEST_CHAT_IDS: '1001',
    SESSIONS: { get: vi.fn(async () => null), put: vi.fn(), delete: vi.fn(), list: vi.fn() },
  });

  it('keeps its deployment identity and state isolated from production', async () => {
    const config = await readFile(new URL('../wrangler.sandbox-sales.toml', import.meta.url), 'utf8');
    expect(config).toContain('name = "trained-assist-tg-bot-sales-sandbox"');
    expect(config).toContain('workers_dev = true');
    expect(config).toContain('BOT_USERNAME = "flexi_leads_bot"');
    expect(config).toContain('SESSION_NAMESPACE = "sales"');
    expect(config).toContain('SANDBOX_REQUIRE_CHAT_ALLOWLIST = "true"');
    expect(config).not.toMatch(/^TEST_CHAT_IDS\s*=/m);
    expect(config).not.toMatch(/^routes\s*=/m);
    expect(config).not.toMatch(/^crons\s*=/m);
    expect(config).not.toContain('id = "74c1930ed8464f4889c056031f0d42f8"');
    expect(config).not.toContain('id = "52240aec81e449eb81bac93ac7917d1f"');
    const ids = [...config.matchAll(/^id = "([a-f0-9]{32})"$/gm)].map(match => match[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('fails closed when the sandbox has no approved chat binding', async () => {
    const result = await signedWebhook(update(1001), env(''));
    expect(result.response.status).toBe(503);
    expect(result.promises).toHaveLength(0);
  });

  it('rejects another chat before dispatch or command registration', async () => {
    const result = await signedWebhook(update(2002), env('1001'));
    expect(result.response.status).toBe(403);
    expect(result.promises).toHaveLength(0);
  });

  it('admits the approved test chat after validating the Telegram secret', async () => {
    fetchSpy.mockImplementation(async () => { throw new Error('sandbox Telegram egress forbidden in this test'); });
    const result = await signedWebhook(update(1001), env('1001'));
    expect(result.response.status).toBe(200);
    await Promise.all(result.promises);
    expect(result.promises).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[test-mode] kind=sendMessage chat=1001'));
  });

  it('still rejects an unsigned test update before reading the allowlist', async () => {
    const result = await signedWebhook(update(1001), env('1001'), 'wrong-secret');
    expect(result.response.status).toBe(401);
    expect(result.promises).toHaveLength(0);
  });
});
