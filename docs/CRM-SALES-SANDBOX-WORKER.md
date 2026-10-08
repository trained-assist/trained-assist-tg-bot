# CRM sales Telegram sandbox Worker

`wrangler.sandbox-sales.toml` deploys `trained-assist-tg-bot-sales-sandbox` as a separate Worker on `workers.dev`. It uses the dedicated `flexi_leads_bot` test identity and its own `SESSIONS` and `USERS` KV namespaces. It has no custom domain, production KV, cron, production bot token or old GCP Agent fallback.

## Provisioning

Set secrets on this Worker only:

```sh
npx wrangler secret put BOT_TOKEN --config wrangler.sandbox-sales.toml
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET --config wrangler.sandbox-sales.toml
npx wrangler secret put SANDBOX_ALLOWED_CHAT_IDS --config wrangler.sandbox-sales.toml
npx wrangler deploy --config wrangler.sandbox-sales.toml
```

Use the local macOS Keychain entries `flexi_test_tg_bot_token` and `flexi_test_tg_chat_id` as the source for the test bot token and its approved chat. Do not print or commit either value. Generate a fresh webhook secret. Replies go only to that test chat, and the required allowlist blocks every other chat before dispatch. No Telegram webhook is changed; probes post a signed synthetic update directly to the sandbox Worker.

The first smoke checks only the bot identity, command menu and `/start` response. It does not authenticate a CRM profile or call an Agent/MCP capability. Do not provision `AGENT_URL` or `AGENT_SECRET` here until the sandbox Control Plane/Runner adapter and CRM MCP binding are available. Production bot `@cmr_management_bot`, its webhook, profile data and provider state are outside this Worker.

## Verification

```sh
npx wrangler deploy --dry-run --config wrangler.sandbox-sales.toml
curl -fsS https://trained-assist-tg-bot-sales-sandbox.<account-subdomain>.workers.dev/health
```

The deployed Worker reports `SANDBOX_REQUIRE_CHAT_ALLOWLIST=true` behavior: missing allowlist fails closed with 503, unapproved chat gets 403, approved signed update reaches the actual gateway handler, and unsigned updates get 401. `GET /debug/commands` reads only the test bot's menu. Test and deployment evidence belongs to TG issue #465 and architecture issue #214.
