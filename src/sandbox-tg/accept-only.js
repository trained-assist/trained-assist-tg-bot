import { Hono } from 'hono';

const app = new Hono();
const MAX_BODY_BYTES = 4096;
const MAX_TEXT_CODEPOINTS = 2000;
const TICKET_TTL_MS = 15 * 60 * 1000;
const IP_WINDOW_MS = 60 * 1000;
const IP_WINDOW_LIMIT = 5;
const TICKET_WINDOW_LIMIT = 60;
const GLOBAL_WINDOW_MS = 24 * 60 * 60 * 1000;
const GLOBAL_WINDOW_LIMIT = 100;
const PRINCIPAL_ID = 'sandbox-accept-only';
const PROFILE_ID = 'sandbox-accept-only-profile';

const encodeBase64Url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
const hex = bytes => [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
const digest = async value => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
const json = (context, body, status = 200) => context.json(body, status, { 'cache-control': 'no-store' });

function enabledForSandbox(env) {
  const production = ['production', 'prod'].includes(String(env.ENVIRONMENT ?? '').toLowerCase()) ||
    ['production', 'prod'].includes(String(env.ENV ?? '').toLowerCase()) ||
    ['super_personal_assistant_bot', 'super_recruiter_assistant_bot', 'freelance_spec_bot'].includes(String(env.BOT_USERNAME ?? '').replace(/^@/, '').toLowerCase());
  const sandboxIdentity = ['probability_cat_bot', 'shturman_bot'].includes(String(env.TG_SANDBOX_BOT_USERNAME ?? '').replace(/^@/, '').toLowerCase());
  return env.TG_ACCEPT_ONLY_ENABLED === 'true' && env.TG_ACCEPT_ONLY_ENVIRONMENT === 'sandbox' &&
    env.TG_ACCEPT_ONLY_MODE === 'accept-only' && !production && !env.BOT_TOKEN && sandboxIdentity &&
    env.SANDBOX_ACCEPT_ONLY?.idFromName && env.SANDBOX_ACCEPT_ONLY?.get;
}

async function readBoundedJson(request) {
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) return { error: 'too_large' };
  if (!request.body) return { error: 'invalid' };
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return { error: 'too_large' };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
  } catch {
    return { error: 'invalid' };
  }
}

function stubFor(env) {
  const id = env.SANDBOX_ACCEPT_ONLY.idFromName('sandbox-accept-only-v1');
  return env.SANDBOX_ACCEPT_ONLY.get(id);
}

app.post('/sandbox/accept-only/requests', async context => {
  const env = context.env;
  if (!enabledForSandbox(env)) return json(context, { error: 'sandbox_accept_only_disabled' }, 404);
  const parsed = await readBoundedJson(context.req.raw);
  if (parsed.error === 'too_large') return json(context, { error: 'request_too_large' }, 413);
  if (parsed.error || !parsed.value || Array.isArray(parsed.value) || Object.keys(parsed.value).length !== 1 ||
      Object.keys(parsed.value)[0] !== 'text' || typeof parsed.value.text !== 'string' ||
      !parsed.value.text.trim() || Array.from(parsed.value.text).length > MAX_TEXT_CODEPOINTS) {
    return json(context, { error: 'invalid_request' }, 400);
  }
  const ip = context.req.header('cf-connecting-ip') || 'unknown';
  const response = await stubFor(env).fetch('https://accept-only.internal/admit', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: parsed.value.text, ipHash: await digest(ip) }),
  });
  const body = await response.json();
  if (!response.ok) return json(context, body, response.status);
  const origin = new URL(context.req.url).origin;
  return json(context, { ...body, eventsUrl: `${origin}/sandbox/accept-only/requests/${body.taskId}/events` }, 202);
});

app.get('/sandbox/accept-only/requests/:taskId/events', async context => {
  if (!enabledForSandbox(context.env)) return json(context, { error: 'sandbox_accept_only_disabled' }, 404);
  const auth = context.req.header('authorization') ?? '';
  const match = /^Bearer ([A-Za-z0-9_-]{40,64})$/.exec(auth);
  if (!match) return json(context, { error: 'not_found' }, 404);
  const afterRaw = context.req.query('after') ?? '0';
  if (!/^(0|[1-9]\d{0,8})$/.test(afterRaw)) return json(context, { error: 'invalid_cursor' }, 400);
  const taskId = context.req.param('taskId');
  if (!/^sbx_[A-Za-z0-9_-]{20,64}$/.test(taskId)) return json(context, { error: 'not_found' }, 404);
  const response = await stubFor(context.env).fetch(`https://accept-only.internal/events/${taskId}?after=${afterRaw}`, {
    headers: { authorization: `Bearer ${match[1]}` },
  });
  return new Response(response.body, { status: response.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
});

export class SandboxAcceptOnlyStore {
  constructor(state) {
    this.state = state;
    this.queue = Promise.resolve();
  }

  fetch(request) {
    const operation = this.queue.then(() => this.handle(request));
    this.queue = operation.catch(() => {});
    return operation;
  }

  async handle(request) {
    const url = new URL(request.url);
    if (url.hostname !== 'accept-only.internal') return Response.json({ error: 'not_found' }, { status: 404 });
    if (request.method === 'POST' && url.pathname === '/admit') return this.admit(request);
    const eventMatch = request.method === 'GET' && /^\/events\/(sbx_[A-Za-z0-9_-]{20,64})$/.exec(url.pathname);
    if (eventMatch) return this.events(eventMatch[1], url.searchParams.get('after') ?? '0', request.headers.get('authorization'));
    return Response.json({ error: 'not_found' }, { status: 404 });
  }

  async admit(request) {
    let body;
    try { body = await request.json(); } catch { return Response.json({ error: 'invalid_request' }, { status: 400 }); }
    if (typeof body?.text !== 'string' || typeof body?.ipHash !== 'string' || !/^[a-f0-9]{64}$/.test(body.ipHash)) {
      return Response.json({ error: 'invalid_request' }, { status: 400 });
    }
    const now = Date.now();
    const random = crypto.getRandomValues(new Uint8Array(32));
    const taskId = `sbx_${encodeBase64Url(crypto.getRandomValues(new Uint8Array(24)))}`;
    const requestId = `req_${taskId.slice(4)}`;
    const ticket = encodeBase64Url(random);
    const ticketHash = await digest(ticket);
    const expiresAt = now + TICKET_TTL_MS;
    const admitted = await this.state.storage.transaction(async storage => {
      const ipKey = `rate:ip:${body.ipHash}`;
      const ipWindow = await storage.get(ipKey);
      const ipCount = ipWindow?.until > now ? ipWindow.count : 0;
      if (ipCount >= IP_WINDOW_LIMIT) return { limited: 'ip' };
      const globalWindow = await storage.get('rate:global');
      const globalCount = globalWindow?.until > now ? globalWindow.count : 0;
      if (globalCount >= GLOBAL_WINDOW_LIMIT) return { limited: 'global' };
      await storage.put(ipKey, { count: ipCount + 1, until: now + IP_WINDOW_MS });
      await storage.put('rate:global', { count: globalCount + 1, until: globalWindow?.until > now ? globalWindow.until : now + GLOBAL_WINDOW_MS });
      await storage.put(`run:${taskId}`, {
        taskId, requestId, text: body.text, principalId: PRINCIPAL_ID, profileId: PROFILE_ID,
        ticketHash, createdAt: now, expiresAt,
      });
      await storage.put(`ticket:${ticketHash}`, taskId);
      return { limited: null };
    });
    if (admitted.limited) return Response.json({ error: 'rate_limited', scope: admitted.limited }, { status: 429 });
    await this.scheduleCleanup(Math.min(expiresAt, now + IP_WINDOW_MS));
    return Response.json({ mode: 'accept_only', taskId, requestId, ticket, expiresAt, executionStarted: false, tokenUsage: 0 });
  }

  async scheduleCleanup(at) {
    const current = await this.state.storage.getAlarm?.();
    if (!current || at < current) await this.state.storage.setAlarm?.(at);
  }

  async alarm() {
    const now = Date.now();
    let next = null;
    for (const [key, value] of await this.state.storage.list()) {
      if (key.startsWith('run:')) {
        if (value.expiresAt <= now) {
          await this.state.storage.delete(key);
          await this.state.storage.delete(`ticket:${value.ticketHash}`);
        } else next = next === null ? value.expiresAt : Math.min(next, value.expiresAt);
      } else if (key.startsWith('rate:ip:') || key.startsWith('rate:ticket:')) {
        if (value.until <= now) await this.state.storage.delete(key);
        else next = next === null ? value.until : Math.min(next, value.until);
      }
    }
    if (next === null) await this.state.storage.deleteAlarm?.();
    else await this.state.storage.setAlarm?.(next);
  }

  async events(taskId, after, authorization) {
    const match = /^Bearer ([A-Za-z0-9_-]{40,64})$/.exec(authorization ?? '');
    if (!match) return Response.json({ error: 'not_found' }, { status: 404 });
    const ticketHash = await digest(match[1]);
    const now = Date.now();
    const access = await this.state.storage.transaction(async storage => {
      const record = await storage.get(`run:${taskId}`);
      const mappedTaskId = await storage.get(`ticket:${ticketHash}`);
      if (!record || record.expiresAt <= now || record.ticketHash !== ticketHash || mappedTaskId !== taskId) return { missing: true };
      const rateKey = `rate:ticket:${ticketHash}`;
      const window = await storage.get(rateKey);
      const count = window?.until > now ? window.count : 0;
      if (count >= TICKET_WINDOW_LIMIT) return { limited: true };
      await storage.put(rateKey, { count: count + 1, until: now + IP_WINDOW_MS });
      return { record };
    });
    if (access.missing) return Response.json({ error: 'not_found' }, { status: 404 });
    if (access.limited) return Response.json({ error: 'rate_limited' }, { status: 429 });
    const record = access.record;
    await this.scheduleCleanup(now + IP_WINDOW_MS);
    const cursor = Number(after);
    const event = { sequence: 1, type: 'accepted_only', taskId, requestId: record.requestId, status: 'accepted_only',
      executionStarted: false, tokenUsage: 0, createdAt: record.createdAt };
    const events = cursor < 1 ? [event] : [];
    return Response.json({ events, nextCursor: 1, hasMore: false });
  }
}

export default {
  fetch: app.fetch,
};
