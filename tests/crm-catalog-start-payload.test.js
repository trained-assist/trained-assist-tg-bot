import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleCommand, parseCrmCatalogStartPayload } from '../src/handlers/commands.js';

afterEach(() => vi.unstubAllGlobals());

const BUILD_ID = 'build-0123456789abcdef01234567';
const COMPANY_ID = 'co-0123456789abcdef0123';
const PAYLOAD = `crm1_${BUILD_ID}_${COMPANY_ID}`;

function memoryKv(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    async get(key) { return values.get(String(key)) ?? null; },
    async put(key, value) { values.set(String(key), value); },
    async delete(key) { values.delete(String(key)); },
    async list({ prefix = '' } = {}) {
      return { keys: [...values.keys()].filter(key => key.startsWith(prefix)).map(name => ({ name })) };
    },
  };
}

function telegramFetch(calls, agentRun = { accepted: true, durable: true }) {
  vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
    const url = new URL(input);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, init, body });
    if (url.pathname === '/run') return Response.json(agentRun, { status: 202 });
    return Response.json({ ok: true, result: { message_id: calls.length } });
  }));
}

describe('CRM catalog Telegram start reference', () => {
  it('accepts only the versioned build and participant identifiers', () => {
    expect(parseCrmCatalogStartPayload(`/start ${PAYLOAD}`)).toEqual({
      kind: 'catalog_participant', buildId: BUILD_ID, companyId: COMPANY_ID,
    });
    expect(parseCrmCatalogStartPayload(`/start@flexi_leads_bot ${PAYLOAD}`)).toEqual({
      kind: 'catalog_participant', buildId: BUILD_ID, companyId: COMPANY_ID,
    });
    expect(parseCrmCatalogStartPayload('/start crm1_build-not-an-id_company')).toEqual({ kind: 'invalid' });
    expect(parseCrmCatalogStartPayload('/start crm1_bad_payload extra')).toEqual({ kind: 'invalid' });
    expect(parseCrmCatalogStartPayload('/start unrelated-payload')).toEqual({ kind: 'none' });
  });

  it('forwards a valid reference through the existing Agent session without accepting profile data from the link', async () => {
    const calls = [];
    telegramFetch(calls);
    const session = { username: 'sandbox-user', name: 'Sandbox User', lastSessionId: 'session-1',
      lastMessageAt: Date.now(), projectId: 'current-project' };
    const env = { BOT_TOKEN: 'test-token', AGENT_URL: 'https://sandbox-agent.test', AGENT_SECRET: 'test-secret',
      SESSION_NAMESPACE: 'sales', SESSIONS: memoryKv({ '123': JSON.stringify(session) }) };
    await handleCommand({ chat: { id: 123, type: 'private' }, from: { id: 123 }, message_id: 77,
      date: Math.floor(Date.now() / 1000), text: `/start ${PAYLOAD}` }, env);

    const run = calls.find(call => call.url.pathname === '/run');
    expect(run).toBeTruthy();
    expect(run.body.audience).toBe('sales');
    expect(run.body.username).toBe('sandbox-user');
    expect(run.body.task).toContain(`participant ${COMPANY_ID}`);
    expect(run.body.task).toContain(`build ${BUILD_ID}`);
    expect(run.body.task).toContain('do not confirm or create');
    expect(run.body).not.toHaveProperty('profileId');
    expect(run.init.headers.Authorization).toBe('Bearer test-secret');
  });

  it('fails closed on malformed links and asks logged-out users to retry after login', async () => {
    const malformedCalls = [];
    telegramFetch(malformedCalls);
    const empty = { BOT_TOKEN: 'test-token', AGENT_URL: 'https://sandbox-agent.test', AGENT_SECRET: 'test-secret',
      SESSION_NAMESPACE: 'sales', SESSIONS: memoryKv() };
    await handleCommand({ chat: { id: 123 }, text: '/start crm1_bad' }, empty);
    expect(malformedCalls.some(call => call.url.pathname === '/run')).toBe(false);
    expect(malformedCalls.some(call => call.body?.text?.includes('повреждена или устарела'))).toBe(true);

    const unauthenticatedCalls = [];
    telegramFetch(unauthenticatedCalls);
    await handleCommand({ chat: { id: 123 }, text: `/start ${PAYLOAD}` }, empty);
    expect(unauthenticatedCalls.some(call => call.url.pathname === '/run')).toBe(false);
    expect(unauthenticatedCalls.some(call => call.body?.text?.includes('снова открой ссылку'))).toBe(true);
  });

  it('does not activate a CRM reference on a different bot audience', async () => {
    const calls = [];
    telegramFetch(calls);
    const env = { BOT_TOKEN: 'test-token', SESSION_NAMESPACE: 'default',
      SESSIONS: memoryKv({ '123': JSON.stringify({ username: 'user', name: 'User' }) }) };
    await handleCommand({ chat: { id: 123 }, text: `/start ${PAYLOAD}` }, env);
    expect(calls.some(call => call.url.pathname === '/run')).toBe(false);
    expect(calls[0].body.text).toContain('Это персональный ассистент');
  });
});
