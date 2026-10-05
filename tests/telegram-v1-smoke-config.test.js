import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readConfig, readLiveConfig, runSmoke } from '../scripts/integration/telegram-v1-smoke.mjs';

const bindings = {
  GATEWAY_URL: 'https://gateway.example.invalid',
  CONTROL_PLANE_URL: 'https://cp.example.invalid',
  CONTROL_PLANE_PRINCIPAL: 'offline',
  CONTROL_PLANE_PROFILE: 'offline',
  CONTROL_PLANE_PRINCIPAL_SIGNATURE: '1'.repeat(64),
  TELEGRAM_WEBHOOK_SECRET: 'offline_secret',
  TG_SANDBOX_BOT_USERNAME: 'probability_cat_bot',
  TG_SLICE_ALLOWED_CHATS: '123',
  TEST_CHAT_ID: 123,
  TEST_USER_ID: 123,
};

describe('Telegram integration smoke request deadline', () => {
  it('allows the synchronous ingress boundary sixty seconds by default', () => {
    expect(readConfig(bindings).requestTimeoutMs).toBe(60_000);
  });

  it('preserves explicit bounded overrides', () => {
    expect(readConfig({ ...bindings, SMOKE_REQUEST_TIMEOUT_MS: 15_000 }).requestTimeoutMs).toBe(15_000);
    expect(() => readConfig({ ...bindings, SMOKE_REQUEST_TIMEOUT_MS: 60_001 })).toThrow();
  });
});

describe('Telegram integration smoke stable live identity', () => {
  const stableBindings = { ...bindings, SMOKE_UPDATE_ID: 901010061, SMOKE_MESSAGE_ID: 901010061 };

  it('requires both explicitly reserved IDs without changing library compatibility', () => {
    expect(() => readLiveConfig(bindings)).toThrow('Missing SMOKE_UPDATE_ID');
    expect(() => readLiveConfig({ ...bindings, SMOKE_UPDATE_ID: 901010061 })).toThrow('Missing SMOKE_MESSAGE_ID');
    expect(readConfig(bindings).updateId).toBeGreaterThan(0);
    expect(readLiveConfig(stableBindings)).toMatchObject({ updateId: 901010061, messageId: 901010061 });
  });

  it.each(['', ' ', 0, -1, 1.5, 2147483648, 'invalid'])('rejects invalid explicit IDs: %s', value => {
    expect(() => readLiveConfig({ ...stableBindings, SMOKE_UPDATE_ID: value })).toThrow();
    expect(() => readLiveConfig({ ...stableBindings, SMOKE_MESSAGE_ID: value })).toThrow();
  });

  it('blocks the live CLI before network when either ID is absent', () => {
    const script = fileURLToPath(new URL('../scripts/integration/telegram-v1-smoke.mjs', import.meta.url));
    for (const supplied of [{}, { SMOKE_UPDATE_ID: '901010061' }]) {
      const result = spawnSync(process.execPath, [script], { env: supplied, encoding: 'utf8', timeout: 5000 });
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'blocked', liveRun: 'not_started' });
    }
  });

  it('bounds requests by the remaining overall budget', async () => {
    const config = { ...readLiveConfig(stableBindings), timeoutMs: 1000 };
    const requests = [];
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      const evidence = await runSmoke(config, {
        emit: () => {},
        fetchImpl: async (_url, options) => {
          requests.push(options);
          return { ok: true, json: async () => ({ status: 'unavailable' }) };
        },
      });
      expect(evidence.outcome).toBe('fail');
      expect(requests).toHaveLength(1);
      expect(requests[0].redirect).toBe('error');
      expect(requests[0].signal).toBeInstanceOf(AbortSignal);
      expect(timeout.mock.calls[0][0]).toBeGreaterThan(0);
      expect(timeout.mock.calls[0][0]).toBeLessThanOrEqual(1000);
    } finally {
      timeout.mockRestore();
    }
  });
});
