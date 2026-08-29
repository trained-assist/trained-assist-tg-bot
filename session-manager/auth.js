/**
 * Dual-auth manager: OAuth (primary) → API Key (fallback)
 *
 * OAuth flow:
 *   1. Spawn `BROWSER= claude auth login` → prints URL to stdout
 *   2. Send URL as Telegram button to user
 *   3. User opens URL, authorizes → Chrome extension (cloud-auth-bridge) captures
 *      the code automatically, OR user pastes it manually
 *   4. Bot calls receiveCode(code) → writes code to the waiting process stdin
 *   5. Process exits 0 → OAuth restored
 *
 * Token push (approach 1 & 2) is handled by trained-assist-auth-sync — not here.
 * If user doesn't respond in 5 min → fall back to API Key mode.
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');

const MODE = { OAUTH: 'oauth', APIKEY: 'apikey' };
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

const AUTH_URL_RE = /https:\/\/(?:claude\.ai|claude\.com)\/[^\s\n\]]+/;

// Matches any auth-related error in Claude output
const AUTH_FAIL_RE = /not logged in|please run.*\/login|authentication (failed|required)|invalid.*api.?key|please log in|unauthorized|401/i;

class AuthManager {
  constructor({ bot, chatId, apiKey, onAuthRestored }) {
    this.bot = bot;
    this.chatId = chatId;
    this.apiKey = apiKey;
    this.onAuthRestored = onAuthRestored;

    this.mode = MODE.OAUTH;
    this._recovering = false;
    this._pendingCodeProc = null;
  }

  // Called by runner when it sees AUTH_FAIL_RE in Claude output
  async handleAuthFailure() {
    if (this._recovering) return;
    this._recovering = true;

    await this._notify('⚠️ Claude не авторизован. Восстанавливаю через OAuth…');

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

  // Returns true if we're waiting for a verification code from the user / extension
  hasPendingCode() { return this._pendingCodeProc !== null; }

  // Called by index.js when user sends a message while hasPendingCode() is true,
  // or when cloud-auth-bridge extension sends the code via relay → log-server
  receiveCode(code) {
    if (!this._pendingCodeProc) return;
    try {
      this._pendingCodeProc.stdin.write(code.trim() + '\n');
    } catch {}
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
      await this._notify('✅ Авторизован через OAuth.');
      this.onAuthRestored(this.mode);
    } else {
      await this._notify('❌ OAuth не удался. Остаюсь на API Key.');
    }
    this._recovering = false;
  }

  currentMode() { return this.mode; }

  // ── private ──────────────────────────────────────────────────────────────────

  async _tryOAuth() {
    return new Promise((resolve) => {
      const proc = spawn('claude', ['auth', 'login'], {
        env: { ...process.env, BROWSER: '' },
      });

      let urlSent = false;
      let timer;

      const cleanup = (success) => {
        clearTimeout(timer);
        this._pendingCodeProc = null;
        resolve(success);
      };

      proc.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        const urlMatch = text.match(AUTH_URL_RE);

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
            '🔐 *Авторизация Claude*\n\n' +
            'Расширение Cloud Auth Bridge откроет ссылку автоматически.\n' +
            'Или открой вручную и пришли код сюда.',
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
          );

          this._pendingCodeProc = proc;

          timer = setTimeout(() => {
            this._pendingCodeProc = null;
            proc.kill('SIGTERM');
            this.bot.telegram.sendMessage(this.chatId, '⏱ Время истекло (5 мин). Переключаюсь на API Key.');
            cleanup(false);
          }, OAUTH_TIMEOUT_MS);
        }
      });

      proc.stderr.on('data', () => {});

      proc.on('close', (code) => {
        if (this._pendingCodeProc === proc) this._pendingCodeProc = null;
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
