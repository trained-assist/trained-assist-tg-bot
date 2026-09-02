# trained-assist-tg-bot

Telegram webhook receiver for trained-assist — runs as a Cloudflare Worker.

## Architecture

```
User (Telegram)
      │
      ▼
trained-assist-tg-bot  (Cloudflare Worker — always-on, stateless)
      │
      ├── simple commands → handled locally (auth, /sessions, /skills, /ping…)
      │
      ├── voice message → Deepgram STR → text → forward as task
      │
      └── task (text/voice) ──────────────────────────────────────────┐
                                                                       │
                  ┌────────────────────────────────────────────────────┘
                  │  smart routing: probe RU VM /capabilities
                  │
                  ├─── has nalog/gosuslugi token on RU VM?
                  │         YES → POST /run → trained-assist-agent (RU VM, 178.212.14.192)
                  │         NO  → POST /run → trained-assist-agent (GCP VM, 136.65.7.197)
                  │
                  └─── agent runs Claude Code, streams output → Telegram API directly
```

**tg-bot** is stateless — all persistent state lives in Cloudflare KV.
**trained-assist-agent** manages sessions, user files, and Claude Code process lifecycle.

### Session routing flow

When a user sends a message, the bot resolves which Claude session to use:

1. **New-session signal** in text ("другая задача", "new task", …) → create new session
2. **User chose session explicitly** via `/sessions` keyboard → use that session
3. **No history** → new session
4. **Recent session < 2h** → auto-continue, no friction
5. **Old session** → fetch last 5 sessions from agent, ask Claude Haiku to classify the message → route automatically if confident, show session-picker keyboard if ambiguous

### Bot → Agent auth

All agent API calls carry `Authorization: Bearer AGENT_SECRET` (shared secret, set as wrangler secret + GCP Secret Manager secret).

## Repos

| Repo | Description |
|------|-------------|
| [trained-assist-tg-bot](https://github.com/trained-assist/trained-assist-tg-bot) | This repo — Cloudflare Worker |
| [trained-assist-agent](https://github.com/trained-assist/trained-assist-agent) | GCP VM agent — Claude Code runner |

## Setup

### 1. Cloudflare KV namespaces

Create two KV namespaces in the Cloudflare dashboard:
- `SESSIONS` — chat_id → session data (active session, pinned message, etc.)
- `USERS` — username → scrypt-hashed password + display name

Update the binding IDs in `wrangler.toml`.

### 2. Wrangler secrets

```bash
wrangler secret put BOT_TOKEN        # Telegram bot token
wrangler secret put BOT_USERNAME     # bot username without @  (e.g. trained_assist_bot)
wrangler secret put BOT_SECRET       # shared secret for Chrome extension auth
wrangler secret put AGENT_URL        # https://136-65-7-197.sslip.io  (GCP VM)
wrangler secret put AGENT_RU_URL     # https://178-212-14-192.sslip.io (RU VM, nalog/gosuslugi)
wrangler secret put AGENT_SECRET     # shared secret for bot↔agent auth
wrangler secret put ADMIN_GROUP_ID   # Telegram group ID for admin commands
wrangler secret put DEEPGRAM_API_KEY # voice transcription
```

### 3. Set Telegram webhook

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://trained-assist-tg-bot.<CF_SUBDOMAIN>.workers.dev/webhook"
```

### 4. GitHub Actions secrets

Set in repo Settings → Secrets → Actions:

| Secret | Description |
|--------|-------------|
| `CF_API_TOKEN` | Cloudflare API token (Workers:Edit permission) |
| `CF_ACCOUNT_ID` | Cloudflare account ID |
| `GH_PAT` | Personal Access Token (`repo` scope) — needed for auto-merge to trigger CI |

> **Why GH_PAT?** GitHub suppresses workflow triggers from pushes made by `GITHUB_TOKEN` (loop-prevention). The auto-merge workflow uses `GH_PAT` so that the squash-merge commit on `main` fires the `CI + Deploy` workflow and the worker gets deployed automatically.

## Development

```bash
npm install
npm run dev    # local dev via wrangler
npm run deploy # deploy to Cloudflare
npm run check  # syntax check
npm test       # unit tests
```

## Development workflow

All changes go through PRs — no direct pushes to `main`.

```bash
git checkout -b fix/description   # or feat/description
# make changes, commit
git push origin fix/description
gh pr create --fill               # CI runs, auto-merges on green (requires GH_PAT secret)
```

CI runs on every PR (`npm run check` + `npm test`). On merge to `main` the worker deploys to Cloudflare and a smoke test verifies `/health` + a fake webhook round-trip.

## Claude Code Instructions

### Architecture rules
- Worker is **stateless** — no in-memory state, all state in KV
- Simple commands (auth, `/sessions`, `/skills`, `/ping`) handled in worker, no agent call
- Claude Code tasks → forwarded to agent via `POST AGENT_URL/run` with `AGENT_SECRET`
- **RU routing**: before forwarding, probe `AGENT_RU_URL/capabilities?userId=…` (2.5s timeout, fail-open to GCP). If the user has a `nalog` or `gosuslugi` capability and the task matches those keywords → route to RU VM
- Passwords hashed with SubtleCrypto PBKDF2 (100k iterations, SHA-256) in KV
- Admin commands only work in `ADMIN_GROUP_ID` chat

### Env vars available in worker
- `env.BOT_TOKEN` — Telegram bot token
- `env.BOT_USERNAME` — bot username (without @)
- `env.BOT_SECRET` — Chrome extension shared secret
- `env.AGENT_URL` — GCP agent base URL
- `env.AGENT_RU_URL` — RU VM agent base URL (optional)
- `env.AGENT_SECRET` — bot↔agent shared secret
- `env.ADMIN_GROUP_ID` — admin Telegram group ID (string)
- `env.SESSIONS` — KV namespace binding
- `env.USERS` — KV namespace binding
- `env.DEEPGRAM_API_KEY` — voice transcription key

### Key source files
| File | Role |
|------|------|
| `src/index.js` | Hono router — webhook dispatch, /health |
| `src/handlers/message.js` | Message handling, session routing, voice transcription |
| `src/handlers/commands.js` | /start, /login, /logout, /sessions, /ping, /skills |
| `src/handlers/callbacks.js` | Inline keyboard callback handling (session picker) |
| `src/handlers/user-mgmt.js` | Admin-group user create/delete/list |
| `src/lib/agent-client.js` | All HTTP calls to trained-assist-agent |
| `src/lib/kv.js` | KV read/write helpers for sessions and users |
| `src/lib/telegram.js` | Telegram API helpers (sendMessage, pinMessage, …) |
| `src/lib/auth.js` | PBKDF2 password hashing and verification |
