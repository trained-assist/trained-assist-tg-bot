/**
 * Dual-auth manager: OAuth (primary) → API Key (fallback)
 *
 * OAuth flow:
 *   1. Spawn `BROWSER= claude auth login` → prints URL to stdout
 *   2. Send URL as Telegram button + ask user to paste verification code
 *   3. User opens URL, authorizes, gets a code, sends it to the bot
 *   4. Bot calls receiveCode(code) → writes code to the waiting process stdin
 *   5. Process exits 0 → OAuth restored
 *
 * If user doesn't respond in 5 min → fall back to API Key mode.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const https = require('https');
const http = require('http');

const MODE = { OAUTH: 'oauth', APIKEY: 'apikey' };
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

const AUTH_URL_RE = /https:\/\/claude\.ai\/[^\s\n]+/;

// Matches any auth-related error in Claude output
const AUTH_FAIL_RE = /not logged in|please run.*\/login|authentication (failed|required)|invalid.*api.?key|please log in|unauthorized|401/i;

class AuthManager {
  constructor({ bot, chatId, apiKey, authSyncUrl, authSyncSecret, onAuthRestored }) {
    this.bot = bot;
    this.chatId = chatId;
    this.apiKey = apiKey;
    this.authSyncUrl = authSyncUrl || null; // URL of local Mac sync server
    this.authSyncSecret = authSyncSecret || null;
    this.onAuthRestored = onAuthRestored;

    this.mode = MODE.OAUTH;
    this._recovering = false;
    this._pendingCodeProc = null;
    this._pendingCodeResolve = null;
  }

  // Called by SessionManager / runner when it sees AUTH_FAIL_RE in output
  async handleAuthFailure(sessionName) {
    if (this._recovering) return;
    this._recovering = true;

    await this._notify(`⚠️ Claude не авторизован. Восстанавливаю…`);

    // Step 1: Try pulling token from local Mac (fast, no user interaction)
    if (this.authSyncUrl) {
      const synced = await this._tryMacSync();
      if (synced) {
        this.mode = MODE.OAUTH;
        this._recovering = false;
        await this._notify('✅ Токен восстановлен с локальной машины.');
        this.onAuthRestored(this.mode);
        return;
      }
    }

    // Step 2: Full OAuth flow (requires user to click link + paste code)
    const ok = await this._tryOAuth();
    if (ok) {
      this.mode = MODE.OAUTH;
      await this._notify('✅ OAuth восстановлен.');
    } else {
      await this._activateApiKeyFallback();
    }

    this._recovering = false;
    this.onAuthRestored(this.mode);
  }

  // POST to Mac sync server → it reads Keychain and SCPs token to this VM
  async _tryMacSync() {
    return new Promise((resolve) => {
      try {
        const url = new URL(this.authSyncUrl);
        const mod = url.protocol === 'https:' ? https : http;
        if (!this.authSyncSecret) { resolve(false); return; }
        const body = JSON.stringify({ secret: this.authSyncSecret });
        const req = mod.request({
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, (res) => {
          let data = '';
          res.on('data', c => { data += c; });
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              resolve(json.ok === true);
            } catch { resolve(false); }
          });
        });
        req.setTimeout(15000, () => { req.destroy(); resolve(false); });
        req.on('error', () => resolve(false));
        req.write(body);
        req.end();
      } catch { resolve(false); }
    });
  }

  // Returns true if we're waiting for the user to paste a verification code
  hasPendingCode() { return this._pendingCodeProc !== null; }

  // Called by index.js when user sends a message while hasPendingCode() is true
  receiveCode(code) {
    if (!this._pendingCodeProc) return;
    try {
      this._pendingCodeProc.stdin.write(code.trim() + '\n');
    } catch {}
    // proc will close once claude auth login processes the code
  }

  getSessionEnv() {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    if (this.mode === MODE.APIKEY) env.ANTHROPIC_API_KEY = this.apiKey;
    return env;
  }

  async forceReauth() {
    if (this._recovering) { await this._notify('Уже идёт авторизация, подожди…'); return; }
    this._recovering = true;
    const ok = await this._tryOAuth();
    if (ok) {
      this.mode = MODE.OAUTH;
      await this._notify('✅ Авторизован через OAuth. Переключился с API Key на аккаунт.');
      this.onAuthRestored(this.mode);
    } else {
      await this._notify('❌ OAuth не удался. Остаюсь на API Key.');
    }
    this._recovering = false;
  }

  currentMode() { return this.mode; }

  // ── private ─────────────────────────────────────────────────────────────────

  async _tryOAuth() {
    return new Promise((resolve) => {
      const proc = spawn('claude', ['auth', 'login'], {
        env: { ...process.env, BROWSER: '' },
      });

      let urlSent = false;
      let codeSent = false;
      let timer;

      const cleanup = (success) => {
        clearTimeout(timer);
        this._pendingCodeProc = null;
        this._pendingCodeResolve = null;
        resolve(success);
      };

      proc.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        const urlMatch = text.match(AUTH_URL_RE);

        // Step 1: Got the auth URL → send to Telegram
        if (urlMatch && !urlSent) {
          urlSent = true;
          const url = urlMatch[0];

          let terminalUrl = null;
          try {
            const log = fs.readFileSync('/tmp/cf-tunnel.log', 'utf8');
            terminalUrl = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0] ?? null;
          } catch {}

          const keyboard = [[{ text: '🔗 Авторизоваться в Claude', url }]];
          if (terminalUrl) keyboard.push([{ text: '🖥 Открыть терминал', url: terminalUrl }]);

          this.bot.telegram.sendMessage(this.chatId,
            '🔐 *Авторизация Claude*\n\n1. Открой ссылку и войди в аккаунт\n2. Скопируй код с сайта\n3. Пришли его сюда в чат',
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
          );

          // Keep proc alive — user will send code via Telegram → receiveCode()
          this._pendingCodeProc = proc;

          timer = setTimeout(() => {
            this._pendingCodeProc = null;
            proc.kill('SIGTERM');
            this.bot.telegram.sendMessage(this.chatId, '⏱ Время истекло (5 мин). Переключаюсь на API Key.');
            cleanup(false);
          }, OAUTH_TIMEOUT_MS);
        }

        // Step 2: Look for "Paste code here" or code prompt patterns
        if (/paste.*code|enter.*code|code:/i.test(text) && !codeSent) {
          codeSent = true;
          // Already notified user in step 1 — nothing extra needed
        }
      });

      proc.stderr.on('data', () => {});

      proc.on('close', (code) => {
        if (this._pendingCodeProc === proc) {
          this._pendingCodeProc = null;
        }
        cleanup(code === 0);
      });

      proc.on('error', () => {
        if (this._pendingCodeProc === proc) this._pendingCodeProc = null;
        cleanup(false);
      });
    });
  }

  async _activateApiKeyFallback() {
    this.mode = MODE.APIKEY;
    await this._notify(
      '🔄 Переключился на API Key (резервный режим).\n' +
      '• Сессии работают без OAuth\n• Вернуться: /reauth'
    );
  }

  _notify(text, opts) {
    return this.bot.telegram.sendMessage(this.chatId, text, opts);
  }
}

module.exports = { AuthManager, AUTH_FAIL_RE, MODE };
