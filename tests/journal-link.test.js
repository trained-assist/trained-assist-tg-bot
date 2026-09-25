import { describe, it, expect } from 'vitest';
import { signJournalTicket, journalLoginUrl, JOURNAL_TICKET_TTL_MS } from '../src/lib/journal-link.js';

// Mirror of trained-assist-web worker.mjs verifyMagicTicket(): if either side
// changes the format/prefix/algorithm, this contract test must change with it.
async function verify(ticket, secret) {
  const [payload, sig] = ticket.split('.');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('HMAC', key, Buffer.from(sig, 'base64url'), new TextEncoder().encode(`journal-login-v1.${payload}`));
  return ok ? JSON.parse(Buffer.from(payload, 'base64url')) : null;
}

describe('journal one-time login link', () => {
  it('signs profile + dialog + expiry + unique nonce with the shared agent secret', async () => {
    const now = 1_790_000_000_000;
    const a = await signJournalTicket('s3cret', { username: 'alice', sessionId: 's-1', now });
    const b = await signJournalTicket('s3cret', { username: 'alice', sessionId: 's-1', now });
    const p = await verify(a, 's3cret');
    expect(p).toMatchObject({ u: 'alice', s: 's-1', e: now + JOURNAL_TICKET_TTL_MS });
    expect(p.n).toMatch(/^[\w-]{16,}$/);
    expect(a).not.toBe(b);
    expect(await verify(a, 'other')).toBeNull();
    expect(a).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });
  it('fails closed without a secret and honours WEB_APP_URL', async () => {
    await expect(signJournalTicket('', { username: 'alice' })).rejects.toThrow(/AGENT_SECRET/);
    const url = await journalLoginUrl({ AGENT_SECRET: 'x', WEB_APP_URL: 'https://web.test/' }, { username: 'bob', sessionId: 's-2' });
    expect(url).toMatch(/^https:\/\/web\.test\/web\/magic\?t=/);
    expect(url.length).toBeLessThan(400);
  });
});
