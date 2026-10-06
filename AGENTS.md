# Repository instructions


## Sandbox-Driven Engineering

Останавливаться до безопасной dev/test-проверки или отказываться от неё из-за вероятности ошибки — вредно для инженерной работы. Не завершайте задачу одним чтением кода, если Environment Contract даёт безопасный путь исполнения. В заявленных изолированных local/dev/test/staging ресурсах самостоятельно запускайте/развёртывайте, подавайте реалистичный input, проверяйте output/logs/state, исправляйте ошибки и повторяйте сценарий. Ошибка в sandbox — evidence, а не повод закончить работу или попросить лишнее подтверждение. Production — отдельная защищённая граница; работайте с ним только по Promotion to Production path этого репозитория.


## Environment Contract

### Development / Test / Staging
**Resources:** local tests via `npm test`; pull/branch staging uses CI-created isolated preview Worker `ta-tg-staging-<suffix>` and `scripts/staging/check-health.mjs`; CI performs staging health and unsigned-webhook rejection. The deployed end-to-end test Worker is `trained-assist-tg-sandbox`, URL `https://trained-assist-tg-sandbox.skillset-apply.workers.dev`, running `src/sandbox-tg/index.js`; its current `/health` response was verified `200`, bot `probability_cat_bot`, mode `direct`, readiness `configured`. It uses sandbox bot secret and separate `TG_SLICE` namespace, plus the CP sandbox URL/principal/profile secrets. Secret names only are inspectable; never expose values.

**Deploy/start:** local `npm ci && npm test`; preview deploy and smoke run automatically on branch pushes via `.github/workflows/ci.yml`. Dedicated integration Worker: `npx wrangler deploy --config wrangler.sandbox-tg.toml` (changes the shared test bot/worker, not the ephemeral PR preview). Health: `curl https://trained-assist-tg-sandbox.skillset-apply.workers.dev/health`.
**Realistic input:** an allowlisted synthetic Telegram update to `POST /webhook` with valid sandbox `TELEGRAM_WEBHOOK_SECRET`, unique `update_id`, and only an approved sandbox chat from `TG_SLICE_ALLOWED_CHATS`; use the documented test bot and its test chat. Expect accepted response with `userTaskId`, then visible test-chat delivery as the CP completes.
**Observe:** `npx wrangler tail --config wrangler.sandbox-tg.toml`; response from `/webhook`, test Telegram chat, CP task status/events, Cloudflare Workers logs and `TG_SLICE` namespace state.
**Reset/retry:** retry with a new `update_id` or a fresh approved test chat. Do not bulk-delete shared KV/DO state or send messages to the production bot. CI preview workers are per-branch and disposable; dedicated test worker state is shared and persistent.
**Agent permissions:** deploy/restart/test traffic in explicitly named sandbox Worker and approved test chat allowed. Production bot `trained-assist-tg-bot` and recruiter/freelance/sales bots are protected. Production deploy is CI on `main` after CI/staging gate; never run Wrangler against default or named production environments directly.

### Production / Promotion
Production Worker names and environments are defined in `wrangler.toml` (default/main and named recruiter, freelance, sales); CI deploys from `main` after scenario/staging gate and runs production bot smoke checks. Main merge leads to automated deploy. Agents may open PR and run staging; no direct production deploy, webhook mutation, production test traffic or production-state reset.

### Testability Contract / Sandbox Gaps
The `/health` and unsigned webhook paths are independently verified. Full bot → CP → output E2E must use only the test bot and allowlisted test chat. No safe bulk reset exists for the shared integration KV/DO state; use unique test identities. The PR preview's CI gate is primarily health/security smoke, not a full Telegram conversation.

