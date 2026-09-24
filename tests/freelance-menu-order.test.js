import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleCommand } from '../src/handlers/commands.js';
import { registerBotCommands } from '../src/lib/telegram.js';

// Owner rule: the freelance bot (@freelance_spec_bot) leads with the freelance
// domain commands, then /remember + the other freelance-specific ones, and only
// then the general assistant commands. Registry order is the single source of
// truth for both /start and setMyCommands — lock it here so a later reshuffle
// can't silently bury the freelance block again.
afterEach(() => vi.unstubAllGlobals());

function sessionEnv(extra = {}) {
  return {
    BOT_TOKEN: 'test',
    SESSIONS: { get: async () => JSON.stringify({ name: 'Freelancer', username: 'fl' }) },
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

const FREELANCE_BLOCK = ['/show_freelance_projects_list', '/build_spec', '/check_project_risk', '/questions', '/new', '/add', '/remember'];

describe('/start leads with the freelance block for the freelance audience', () => {
  it('lists the freelance commands before the general bot commands', async () => {
    const text = await startText(sessionEnv({ SESSION_NAMESPACE: 'freelance' }));
    for (const cmd of FREELANCE_BLOCK) expect(text).toContain(cmd);
    const loginAt = text.indexOf('/login');
    const firstFl = text.indexOf('/show_freelance_projects_list');
    const rememberAt = text.indexOf('/remember');
    expect(loginAt).toBeGreaterThan(-1);
    expect(firstFl).toBeGreaterThan(-1);
    expect(firstFl).toBeLessThan(loginAt);
    expect(rememberAt).toBeLessThan(loginAt);
  });

  it('does not leak freelance-only commands to the default audience', async () => {
    const text = await startText(sessionEnv());
    for (const cmd of ['/show_freelance_projects_list', '/build_spec', '/check_project_risk', '/remember']) {
      expect(text).not.toContain(cmd);
    }
  });
});

describe('setMyCommands order for the freelance audience', () => {
  it('sends the freelance block before the general commands', async () => {
    let sent = null;
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      sent = JSON.parse(opts.body).commands;
      return Response.json({ ok: true });
    }));
    await registerBotCommands('tok', { audience: 'freelance' });
    const names = sent.map((c) => c.command);
    expect(names[0]).toBe('start');
    const idx = (n) => names.indexOf(n);
    expect(idx('show_freelance_projects_list')).toBeGreaterThan(-1);
    expect(idx('show_freelance_projects_list')).toBeLessThan(idx('login'));
    expect(idx('build_spec')).toBeLessThan(idx('login'));
    expect(idx('check_project_risk')).toBeLessThan(idx('login'));
    expect(idx('remember')).toBeLessThan(idx('login'));
  });
});
