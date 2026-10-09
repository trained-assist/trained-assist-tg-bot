import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const config = readFileSync(new URL('../wrangler.sandbox-tg-sandbox3.toml', import.meta.url), 'utf8');
const probability = readFileSync(new URL('../wrangler.sandbox-tg-existing-ux.toml', import.meta.url), 'utf8');
const shturman = readFileSync(new URL('../wrangler.sandbox-tg-shturman.toml', import.meta.url), 'utf8');
const kvIds = text => [...text.matchAll(/^id = "([a-f0-9]{32})"$/gm)].map(match => match[1]);

describe('sandbox-3 Telegram lane configuration', () => {
  it('routes only to the dedicated CP and keeps its own identity', () => {
    expect(config).toMatch(/^name = "trained-assist-tg-sandbox3"$/m);
    expect(config).toMatch(/^CONTROL_PLANE_URL = "https:\/\/trained-assist-cp-sandbox3\.skillset-apply\.workers\.dev"$/m);
    expect(config).toMatch(/^CONTROL_PLANE_PRINCIPAL = "integration-sandbox3-v1"$/m);
    expect(config).toMatch(/^CONTROL_PLANE_PROFILE = "integration-sandbox3-v1"$/m);
    expect(config).not.toContain('trained-assist-cp-telegram-ux-v1-sandbox');
  });

  it('keeps distinct KV state and leaves credentials outside source', () => {
    const ours = kvIds(config);
    const others = new Set([...kvIds(probability), ...kvIds(shturman)]);
    expect(ours).toHaveLength(2);
    expect(new Set(ours).size).toBe(2);
    expect(ours.every(id => !others.has(id))).toBe(true);
    expect(config).not.toMatch(/^TG_SANDBOX_BOT_TOKEN\s*=/m);
    expect(config).not.toMatch(/^CONTROL_PLANE_PRINCIPAL_SIGNATURE\s*=/m);
  });
});
