import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleCommand } from '../src/handlers/commands.js';
import { registerBotCommands } from '../src/lib/telegram.js';

// The main personal-assistant bot (env, no SESSION_NAMESPACE) has no HH skill
// enabled — HH/vacancy commands (recruiterOnly:true) must not appear in its
// /start listing or its Telegram command menu. The recruiter bot must still
// see them, plus recruiter-relevant commands like /persona that used to be
// wrongly marked recruiterHidden. See commands-registry.json.
afterEach(() => vi.unstubAllGlobals());

function sessionEnv(extra = {}) {
  return {
    BOT_TOKEN: 'test',
    SESSIONS: { get: async () => JSON.stringify({ name: 'Test User', username: 'tester' }) },
    ...extra,
  };
}

async function startText(env) {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    return Response.json({ ok: true, result: { message_id: 1 } });
  }));
  await handleCommand({ chat: { id: 1 }, text: '/start', from: { id: 1 } }, env);
  return calls[0].text;
}

describe('/start command listing is audience-aware', () => {
  it('main bot (default audience) hides recruiterOnly HH commands', async () => {
    const text = await startText(sessionEnv());
    expect(text).not.toContain('/hh_status');
    expect(text).not.toContain('/new_job_post');
    expect(text).not.toMatch(/HeadHunter \(0\)/);
  });

  it('main bot still shows /persona (must not be recruiter-only)', async () => {
    const text = await startText(sessionEnv());
    expect(text).toContain('/persona');
  });

  it('recruiter bot shows HH commands and /persona, hides /project', async () => {
    const text = await startText(sessionEnv({ SESSION_NAMESPACE: 'recruiter' }));
    expect(text).toContain('/hh_status');
    expect(text).toContain('/persona');
    expect(text).not.toContain('/project');
  });
});

describe('registerBotCommands is audience-aware', () => {
  it('default audience omits recruiterOnly entries from setMyCommands', async () => {
    let sentCommands;
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      sentCommands = JSON.parse(opts.body).commands;
      return Response.json({ ok: true });
    }));
    await registerBotCommands('tok', { audience: 'default' });
    expect(sentCommands.some((c) => c.command === 'hh_status')).toBe(false);
    expect(sentCommands.some((c) => c.command === 'persona')).toBe(true);
  });

  it('recruiter audience includes recruiterOnly entries and /persona, omits /project', async () => {
    let sentCommands;
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      sentCommands = JSON.parse(opts.body).commands;
      return Response.json({ ok: true });
    }));
    await registerBotCommands('tok', { audience: 'recruiter' });
    expect(sentCommands.some((c) => c.command === 'hh_status')).toBe(true);
    expect(sentCommands.some((c) => c.command === 'persona')).toBe(true);
    expect(sentCommands.some((c) => c.command === 'project')).toBe(false);
  });
});
