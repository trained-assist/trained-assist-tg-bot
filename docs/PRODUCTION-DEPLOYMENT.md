# Telegram gateway production deployment and rollback

## Normal release

A push to protected `main` deploys automatically after the same revision passes CI, mandatory scenario replay, isolated staging deployment and health smoke, and `staging-gate`. Production smoke then checks exact `buildSha`, each enabled bot identity, and rejection of an unsigned webhook (`401`).

`workflow_dispatch` is recovery only. It defaults to no deployment; selecting `recovery_deploy` on `main` repeats the same checks and staging gate before production.

## Rollback after a failed production release

First record the active and preceding Worker versions for every Worker that the failed release deployed:

```bash
npx wrangler whoami
npx wrangler deployments list --name trained-assist-tg-bot
npx wrangler deployments list --name trained-assist-tg-bot-recruiter
npx wrangler deployments list --name trained-assist-tg-bot-freelance
npx wrangler deployments list --name trained-assist-tg-bot-sales
```

For each affected Worker, use the `version_id` from the immediately preceding known-good deployment:

```bash
npx wrangler rollback <previous-version-id> --name <worker-name> --message 'Rollback after failed production smoke' --yes
```

Then verify the restored Worker:

```bash
curl -fsS https://trained-assist-tg-bot.skillset-apply.workers.dev/health
curl -fsS https://trained-assist-tg-bot-recruiter.skillset-apply.workers.dev/health
curl -fsS https://tg-freelance.trainedassist.store/health
```

Compare every `buildSha` to the intended prior revision, check `/debug/whoami` for that Worker’s bot identity, and confirm an unsigned `POST /webhook` returns `401`. For optional `sales`, use `https://trained-assist-tg-bot-sales.skillset-apply.workers.dev` only when `SALES_BOT_TOKEN` was enabled for that release.

Before Wrangler changes, `wrangler whoami` must show `typeformowner@gmail.com` and Cloudflare account `d740a05e9442c1d0feacae2dfc673e93`. Use the GitHub/Cloudflare credential store; never copy token values into commands, logs, or this repository.

Cloudflare rollback changes Worker code/version only. It does not roll back Durable Object, KV, R2, or other bound state. Review state changes separately before rollback; never reset shared staging or production data as part of a Worker rollback.
