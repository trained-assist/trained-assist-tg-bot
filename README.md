# alesa-bot

Telegram webhook receiver for Alesa — runs as a Cloudflare Worker.

## Architecture

```
Telegram → alesa-bot (CF Worker, always-on) → alesa-agent (GCP VM, Claude Code runner)
                ↓ simple commands handled locally
                ↓ tasks forwarded via POST /run to agent
```

**alesa-bot** is stateless: sessions and user registry live in Cloudflare KV.  
**alesa-agent** runs `claude --dangerously-skip-permissions` and streams results back to Telegram API directly.

## Repos

| Repo | Description |
|------|-------------|
| [alesa-bot](https://github.com/trained-assist/alesa-bot) | This repo — Cloudflare Worker |
| [alesa-agent](https://github.com/trained-assist/alesa-agent) | GCP VM agent — Claude Code runner |

## Setup

### 1. Cloudflare KV namespaces

Create two KV namespaces in your Cloudflare dashboard:
- `SESSIONS` — chat_id → session data
- `USERS` — user registry (username → hash/salt/name)

Update the IDs in `wrangler.toml`.

### 2. Wrangler secrets

```bash
wrangler secret put BOT_TOKEN      # Telegram bot token
wrangler secret put BOT_SECRET     # shared secret for Chrome extension
wrangler secret put AGENT_URL      # https://your-agent-domain.com
wrangler secret put AGENT_SECRET   # shared secret for bot↔agent auth
```

### 3. Set Telegram webhook

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://alesa-bot.<CF_SUBDOMAIN>.workers.dev/webhook"
```

### 4. GitHub Actions secrets

Set in repo Settings → Secrets:

| Secret | Description |
|--------|-------------|
| `CF_API_TOKEN` | Cloudflare API token (Workers:Edit permission) |
| `CF_ACCOUNT_ID` | Cloudflare account ID |

## Development

```bash
npm install
npm run dev    # local dev via wrangler
npm run deploy # deploy to Cloudflare
```

## Development workflow

All changes go through PRs — no direct pushes to `main`.

```bash
git checkout -b fix/description   # or feat/description
# make changes, commit
git push origin fix/description
gh pr create --fill               # CI runs, auto-merges on green
```

CI runs on every PR (`npm run check` + `npm test`). On merge to `main`, the worker deploys to Cloudflare and a smoke test verifies `/health` + a fake webhook round-trip. Auto-merge is enabled via `.github/workflows/auto-merge.yml` — PRs squash-merge automatically when CI passes.

## Claude Code Instructions

### Architecture rules
- Worker is **stateless** — no in-memory state, all state in KV
- Simple commands (auth, user mgmt) handled in worker
- Claude Code tasks → forwarded to alesa-agent via `AGENT_URL/run`
- Passwords hashed with SubtleCrypto PBKDF2 (100k iterations, SHA-256)
- Admin commands only work in `ADMIN_GROUP_ID` chat

### Env vars available in worker
- `env.BOT_TOKEN` — Telegram bot token
- `env.BOT_SECRET` — Chrome extension shared secret
- `env.AGENT_URL` — alesa-agent base URL
- `env.AGENT_SECRET` — bot↔agent shared secret
- `env.ADMIN_GROUP_ID` — admin Telegram group ID (string)
- `env.SESSIONS` — KV namespace binding
- `env.USERS` — KV namespace binding
