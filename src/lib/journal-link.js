// «📜 Журнал» → one-time login link into the web app (app.trainedassist.store).
// The pressing Telegram user is already authenticated here (KV session), so we
// sign a short-lived ticket {u, s, e, n} with the bot↔agent shared secret; the
// web worker verifies it with the same value (its AGENT_VERIFY_SECRET), burns
// the nonce once and sets its own httpOnly cookie for THIS profile. No password
// travels in the URL; a leaked link dies after one use or JOURNAL_TICKET_TTL_MS.
// Contract twin: trained-assist-web worker.mjs verifyMagicTicket().
export const JOURNAL_TICKET_TTL_MS = 10 * 60 * 1000;
const enc = new TextEncoder();
const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function signJournalTicket(secret, { username, sessionId, now = Date.now(), ttlMs = JOURNAL_TICKET_TTL_MS }) {
  if (!secret) throw new Error('AGENT_SECRET is not configured');
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const payload = b64url(enc.encode(JSON.stringify({ u: username, s: sessionId || undefined, e: now + ttlMs, n: nonce })));
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `${payload}.${b64url(await crypto.subtle.sign('HMAC', key, enc.encode(`journal-login-v1.${payload}`)))}`;
}

export async function journalLoginUrl(env, { username, sessionId }) {
  const base = (env.WEB_APP_URL || 'https://app.trainedassist.store').replace(/\/+$/, '');
  return `${base}/web/magic?t=${await signJournalTicket(env.AGENT_SECRET, { username, sessionId })}`;
}
