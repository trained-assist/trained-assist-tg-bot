/**
 * token-relay — HTTP сервис для привязки Chrome-расширения.
 *
 * Endpoints:
 *   POST /generate-pair-code  ← вызывает бот (auth: BOT_SECRET)
 *   POST /pair                ← вызывает расширение (с кодом из Telegram)
 *   POST /save-token          ← вызывает расширение (токен сервиса → GCP Secret Manager)
 *   GET  /status/:userId      ← вызывает бот (auth: BOT_SECRET)
 *   POST /queue-command       ← вызывает бот (auth: BOT_SECRET) — ставит команду в очередь расширению
 *   HEAD /poll/:userId        ← вызывает расширение (auth: pairingToken) — 204 пусто / 200 есть команда
 *   GET  /poll/:userId        ← вызывает расширение (auth: pairingToken) — забирает команду из очереди
 */

const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 8081;
const BOT_SECRET = process.env.BOT_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const AGENT_RU_URL = process.env.AGENT_RU_URL || 'https://178-212-14-192.sslip.io';
const AGENT_SECRET = process.env.AGENT_SECRET || '1ea8378c5ab06cb9f003118ffde024265f263edb307a014a';


if (!BOT_SECRET)   console.warn('WARNING: BOT_SECRET not set — bot endpoints will reject all requests');
if (!TELEGRAM_BOT_TOKEN) console.warn('WARNING: TELEGRAM_BOT_TOKEN not set — user notifications disabled');

// userId → { code, expiresAt }
const pairCodes = new Map();
// userId → { token, createdAt }
const pairTokens = new Map();
// userId → Array<{ command, payload, createdAt, expiresAt }>
const commandQueues = new Map();

// ── Persistence: save/load pairTokens to file ─────────────────────────────
const fs = require('fs');
const TOKENS_FILE = '/home/vova/token-relay/pair-tokens.json';

function saveTokens() {
  try {
    const obj = {};
    for (const [uid, entry] of pairTokens) obj[uid] = entry;
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(obj, null, 2));
  } catch (e) { console.error('[relay] saveTokens error:', e.message); }
}

function loadTokens() {
  try {
    if (!fs.existsSync(TOKENS_FILE)) return;
    const obj = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    for (const [uid, entry] of Object.entries(obj)) pairTokens.set(uid, entry);
    console.log(`[relay] loaded ${pairTokens.size} pairing token(s) from disk`);
  } catch (e) { console.error('[relay] loadTokens error:', e.message); }
}

loadTokens();

const COMMAND_TTL_MS = 30 * 60 * 1000; // команды живут 30 минут

function generateCode() {
  return (Math.floor(Math.random() * 900000) + 100000).toString();
}

function generatePairingToken() {
  return crypto.randomBytes(32).toString('hex');
}

function cleanupExpired() {
  const now = Date.now();
  for (const [uid, e] of pairCodes) {
    if (e.expiresAt < now) pairCodes.delete(uid);
  }
}

async function notifyUser(chatId, html) {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: 'HTML' }),
    });
  } catch (e) {
    console.error('notifyUser error:', e.message);
  }
}

function readBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
    });
  });
}

function isBotAuthed(req) {
  return BOT_SECRET && req.headers.authorization === `Bearer ${BOT_SECRET}`;
}

// Найти userId по pairingToken из Authorization header расширения
function userIdByPairingToken(req) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  for (const [uid, entry] of pairTokens) {
    if (entry.token === token) return uid;
  }
  return null;
}

// Убрать истёкшие команды из очереди пользователя
function pruneCommands(userId) {
  const queue = commandQueues.get(userId);
  if (!queue) return;
  const now = Date.now();
  const fresh = queue.filter(c => c.expiresAt > now);
  if (fresh.length) commandQueues.set(userId, fresh);
  else commandQueues.delete(userId);
}

const server = http.createServer(async (req, res) => {
  const send = (status, data) => {
    const body = JSON.stringify(data);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end(body);
  };

  // Preflight for extension (Chrome extensions don't send CORS preflight for same-origin,
  // but CF tunnel might trigger OPTIONS)
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
    return res.end();
  }

  const body = await readBody(req);

  // ── POST /generate-pair-code (bot → relay) ─────────────────────────────────

  if (req.method === 'POST' && req.url === '/generate-pair-code') {
    if (!isBotAuthed(req)) return send(401, { error: 'Unauthorized' });

    const { userId } = body;
    if (!userId) return send(400, { error: 'userId required' });

    cleanupExpired();
    const code = generateCode();
    pairCodes.set(String(userId), { code, expiresAt: Date.now() + 10 * 60 * 1000 });
    console.log(`[relay] pair code generated for userId=${userId}`);
    return send(200, { code });
  }

  // ── POST /pair (extension → relay) ─────────────────────────────────────────

  if (req.method === 'POST' && req.url === '/pair') {
    const { code } = body;
    if (!code) return send(400, { error: 'code required' });

    const normalized = String(code).replace(/\s/g, '');
    const now = Date.now();

    // Find before cleanup so we can distinguish expired vs never-existed
    let userId = null;
    let foundExpired = false;
    for (const [uid, entry] of pairCodes) {
      if (entry.code === normalized) {
        if (entry.expiresAt > now) userId = uid;
        else foundExpired = true;
        break;
      }
    }

    cleanupExpired();

    if (!userId) {
      return foundExpired
        ? send(410, { error: 'code_expired' })
        : send(400, { error: 'invalid_code' });
    }

    const pairingToken = generatePairingToken();
    pairCodes.delete(userId);
    pairTokens.set(userId, { token: pairingToken, createdAt: Date.now() });
    saveTokens();

    console.log(`[relay] paired userId=${userId}`);
        // Forward token to RU VM (geo-blocked services like nalog.ru)
    if (AGENT_RU_URL && AGENT_SECRET) {
      fetch(`${AGENT_RU_URL}/tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AGENT_SECRET}` },
        body: JSON.stringify({ userId, label, value: tokenValue }),
      }).then(r => console.log(`[relay] RU VM token sync: ${r.status}`))
        .catch(e => console.warn('[relay] RU VM token sync failed:', e.message));
    }

    await notifyUser(Number(userId),
      '🔗 <b>Chrome-расширение подключено!</b>\nТеперь могу получать токены авторизации из браузера.'
    );

    return send(200, { pairingToken });
  }

  // ── POST /save-token (extension → relay) ───────────────────────────────────
  // Extension sends: { pairingToken, label, tokenValue }
  // Relay saves to GCP Secret Manager and notifies user.

  if (req.method === 'POST' && req.url === '/save-token') {
    const { pairingToken, label, tokenValue } = body;
    if (!pairingToken || !label || !tokenValue) {
      return send(400, { error: 'pairingToken, label, tokenValue required' });
    }

    let userId = null;
    for (const [uid, entry] of pairTokens) {
      if (entry.token === pairingToken) { userId = uid; break; }
    }

    if (!userId) return send(401, { error: 'Invalid pairing token' });

    console.log(`[relay] token received label="${label}" for userId=${userId}`);

    // Save token to disk — agent reads before launching Claude
    try {
      const dir = `/home/vova/agent-tokens/${userId}`;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(`${dir}/${label}`, String(tokenValue), { mode: 0o600 });
      console.log(`[relay] saved token disk: ${dir}/${label}`);
    } catch (e) {
      console.error('[relay] failed to save token:', e.message);
    }

    // Forward claude auth code to bot log-server (bypasses Telegram)
    if (label === 'claude_auth_code') {
      try {
        let code = tokenValue;
        try { code = JSON.parse(tokenValue).code || tokenValue; } catch {}
        const http2 = require('http');
        const fwdBody = JSON.stringify({ code });
        const fwdReq = http2.request({
          hostname: 'localhost', port: 8080,
          path: '/api/auth-code?t=alesa2026',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(fwdBody) }
        }, (r) => { r.resume(); });
        fwdReq.on('error', () => {});
        fwdReq.write(fwdBody);
        fwdReq.end();
        console.log(`[relay] forwarded claude_auth_code to bot log-server`);
        return send(200, { ok: true });
      } catch (e) {
        console.error('[relay] auth-code forward error:', e.message);
      }
    }

    await notifyUser(Number(userId),
      `🔒 Токен <b>${escapeHtml(label)}</b> получен.\nСохраню по запросу.`
    );

    return send(200, { ok: true });
  }

  // ── GET /status/:userId (bot → relay) ──────────────────────────────────────

  if (req.method === 'GET' && req.url.startsWith('/status/')) {
    if (!isBotAuthed(req)) return send(401, { error: 'Unauthorized' });

    const userId = req.url.slice('/status/'.length);
    const connected = pairTokens.has(userId);
    return send(200, { connected });
  }

  // ── POST /queue-command (bot → relay) ─────────────────────────────────────
  // Ставит команду в очередь для расширения. Расширение заберёт при следующем poll.
  // Body: { userId, command, payload? }
  // Команды: fetch_token (payload: { site, description }), refresh_session, etc.

  if (req.method === 'POST' && req.url === '/queue-command') {
    if (!isBotAuthed(req)) return send(401, { error: 'Unauthorized' });

    const { userId, command, payload } = body;
    if (!userId || !command) return send(400, { error: 'userId and command required' });
    if (!pairTokens.has(String(userId))) return send(404, { error: 'User not paired' });

    if (!commandQueues.has(String(userId))) commandQueues.set(String(userId), []);
    commandQueues.get(String(userId)).push({
      command,
      payload: payload || {},
      createdAt: Date.now(),
      expiresAt: Date.now() + COMMAND_TTL_MS,
    });

    console.log(`[relay] queued command="${command}" for userId=${userId}`);
    return send(200, { ok: true, queued: commandQueues.get(String(userId)).length });
  }

  // ── HEAD /poll  GET /poll (extension → relay) ────────────────────────────
  // Лёгкая проверка: есть ли команда в очереди?
  // Auth: Authorization: Bearer {pairingToken}  — userId определяется по токену
  // HEAD 204 = ничего нет (остаться в idle)
  // HEAD 200 = есть команда (переключиться в fast mode, затем сделать GET /poll)
  // GET  200 = { command, payload } — забирает и удаляет первую команду
  // GET  204 = очередь пуста — вернуться в idle

  if ((req.method === 'HEAD' || req.method === 'GET') && (req.url === '/poll' || req.url.startsWith('/poll?'))) {
    const userId = userIdByPairingToken(req);
    if (!userId) return send(401, { error: 'Unauthorized' });

    pruneCommands(userId);
    const queue = commandQueues.get(userId);
    const hasPending = queue && queue.length > 0;

    if (req.method === 'HEAD') {
      // HEAD: только статус, без тела — минимальный трафик
      res.writeHead(hasPending ? 200 : 204, {
        'Access-Control-Allow-Origin': '*',
        'X-Pending': hasPending ? '1' : '0',
      });
      return res.end();
    }

    // GET: вернуть и удалить первую команду из очереди
    if (!hasPending) return send(204, null);
    const cmd = queue.shift();
    if (!queue.length) commandQueues.delete(userId);
    console.log(`[relay] command delivered command="${cmd.command}" to userId=${userId}`);
    return send(200, { command: cmd.command, payload: cmd.payload });
  }


  // ── POST /debug (extension → relay) ──────────────────────────────────────
  // Silent debug logging from extension SW — no Telegram notification
  if (req.method === 'POST' && req.url === '/debug') {
    const { pairingToken, step, detail } = body;
    let userId = null;
    for (const [uid, entry] of pairTokens) {
      if (entry.token === pairingToken) { userId = uid; break; }
    }
    if (!userId) return send(401, { error: 'Unauthorized' });
    console.log(`[ext-debug] userId=${userId} step=${step} ${detail}`);
    return send(200, { ok: true });
  }

  // ── GET /healthz ────────────────────────────────────────────────────────────

  if (req.method === 'GET' && req.url === '/healthz') {
    return send(200, { ok: true, pairs: pairTokens.size, pendingCodes: pairCodes.size, commandQueues: commandQueues.size });
  }

  send(404, { error: 'Not found' });
});

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

server.listen(PORT, () => {
  console.log(`token-relay started on port ${PORT}`);
});

process.once('SIGINT',  () => { console.log('token-relay stopping'); process.exit(0); });
process.once('SIGTERM', () => { console.log('token-relay stopping'); process.exit(0); });
