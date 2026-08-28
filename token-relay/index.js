/**
 * token-relay — HTTP сервис для привязки Chrome-расширения.
 *
 * Endpoints:
 *   POST /generate-pair-code  ← вызывает бот (auth: BOT_SECRET)
 *   POST /pair                ← вызывает расширение (с кодом из Telegram)
 *   POST /save-token          ← вызывает расширение (токен сервиса → GCP Secret Manager)
 *   GET  /status/:userId      ← вызывает бот (auth: BOT_SECRET)
 */

const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 8081;
const BOT_SECRET = process.env.BOT_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!BOT_SECRET)   console.warn('WARNING: BOT_SECRET not set — bot endpoints will reject all requests');
if (!TELEGRAM_BOT_TOKEN) console.warn('WARNING: TELEGRAM_BOT_TOKEN not set — user notifications disabled');

// userId → { code, expiresAt }
const pairCodes = new Map();
// userId → { token, createdAt }
const pairTokens = new Map();

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

    cleanupExpired();
    const normalized = String(code).replace(/\s/g, '');

    let userId = null;
    for (const [uid, entry] of pairCodes) {
      if (entry.code === normalized) { userId = uid; break; }
    }

    if (!userId) return send(400, { error: 'Invalid or expired code' });

    const pairingToken = generatePairingToken();
    pairCodes.delete(userId);
    pairTokens.set(userId, { token: pairingToken, createdAt: Date.now() });

    console.log(`[relay] paired userId=${userId}`);
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

    // TODO v2: save to GCP Secret Manager as `tg_{userId}__token-{label}`
    // For MVP: just notify user; actual saving happens when user asks Claude
    console.log(`[relay] token received label="${label}" for userId=${userId}`);
    await notifyUser(Number(userId),
      `🔒 Токен <b>${escapeHtml(label)}</b> получен.\nАлеса сохранит его по запросу.`
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

  // ── GET /healthz ────────────────────────────────────────────────────────────

  if (req.method === 'GET' && req.url === '/healthz') {
    return send(200, { ok: true, pairs: pairTokens.size, pending: pairCodes.size });
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
