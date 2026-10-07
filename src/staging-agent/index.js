// Deterministic, tool-less backend for the shared Telegram staging Worker.
// This deliberately implements only the small legacy agent contract needed by
// safe Telegram E2E. It cannot access MCP, user tokens, files, or production.

const RESERVED_CHAT_MIN = -100_000_000_000_100;
const RESERVED_CHAT_MAX = -100_000_000_000_000;
// A custom Wrangler config name may not inherit the default account's secrets.
// Keep a second, explicit opt-in binding for local development and reject empty
// configuration before authorizing any API request.
function expectedSecret(env) {
  return typeof env.AGENT_SECRET === 'string' && env.AGENT_SECRET.length > 0
    ? env.AGENT_SECRET
    : (typeof env.TEST_AGENT_SECRET === 'string' ? env.TEST_AGENT_SECRET : '');
}
const REQUEST_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function authorized(request, env) {
  const secret = expectedSecret(env);
  return secret.length > 0 && request.headers.get('Authorization') === `Bearer ${secret}`;
}

function isTestUser(username, env) {
  return typeof env.TEST_USERNAME === 'string' && username === env.TEST_USERNAME;
}

function answerFor(task) {
  const text = task.trim().toLowerCase();
  if (/^\/help(?:\s|$)/.test(text)) {
    return 'Тестовый агент: /help работает. Я отвечаю на безопасные тестовые запросы; инструменты отключены.';
  }
  if (/^(работает|пинг|ping|ты онлайн)/.test(text)) {
    return 'Да, тестовый агент отвечает. Внешние инструменты отключены.';
  }
  return 'Тестовая задача принята и завершена. Внешние инструменты и действия отключены.';
}

async function handleRun(request, env) {
  if (!authorized(request, env)) return json({ error: 'unauthorized' }, 401);
  const body = await request.json().catch(() => null);
  const chatId = Number(body?.chatId ?? body?.userId);
  if (!isTestUser(body?.username, env) || body?.delivery !== 'log' ||
      !Number.isSafeInteger(chatId) || chatId < RESERVED_CHAT_MIN || chatId > RESERVED_CHAT_MAX ||
      Number(body?.userId) !== chatId || !REQUEST_ID_RE.test(body?.requestId || '') ||
      typeof body?.task !== 'string' || body.task.trim().length === 0 || body.task.length > 5000) {
    return json({ error: 'test-only run rejected' }, 403);
  }

  if (typeof env.GATEWAY_URL !== 'string' || !env.GATEWAY_URL.startsWith('https://')) {
    return json({ error: 'staging gateway callback is not configured' }, 503);
  }

  const answer = answerFor(body.task);
  const callback = await fetch(`${env.GATEWAY_URL.replace(/\/$/, '')}/internal/run-finished`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${expectedSecret(env)}`,
    },
    body: JSON.stringify({
      chatId,
      requestId: body.requestId,
      outcome: 'quick',
      answer,
    }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  if (!callback?.ok) return json({ error: 'staging gateway callback failed' }, 502);

  // Do not retain or log task content. Replays are safe because this backend has
  // no tools, mutable profile state, or external side effects.
  return json({ durable: true, requestId: body.requestId, taskId: `test-${body.requestId}` }, 202);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ status: 'alive', mode: 'test-only', toolsEnabled: false });
    }
    if (!authorized(request, env)) return json({ error: 'unauthorized' }, 401);

    if (request.method === 'GET' && url.pathname === '/maintenance') {
      return json({ paused: false, phase: 'ready', active: 0, durableIngress: 1 });
    }
    if (request.method === 'GET' && url.pathname === '/project-decision') {
      if (!isTestUser(url.searchParams.get('username'), env)) return json({ error: 'test user only' }, 403);
      return json({ action: 'quick', choices: [] });
    }
    if (request.method === 'GET' && url.pathname === '/projects') {
      if (!isTestUser(url.searchParams.get('username'), env)) return json({ error: 'test user only' }, 403);
      return json({ projects: [] });
    }
    if (request.method === 'GET' && url.pathname === '/sessions') return json({ sessions: [] });
    if (request.method === 'POST' && url.pathname === '/classify') {
      return json({ sessionId: null, confidence: 'low' });
    }
    if (request.method === 'POST' && url.pathname === '/run') return handleRun(request, env);
    return json({ error: 'not found' }, 404);
  },
};
