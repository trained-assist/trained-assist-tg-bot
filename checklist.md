Goal: third Telegram bot (freelance) wired into the gateway safely — PR-A2 of issue #1302

- [x] §4.1 `resolveAudience(env)` replaces the 5× `SESSION_NAMESPACE` ternary (agent-client.js / commands.js / telegram.js)
- [x] §4.2 `[env.freelance]` in wrangler.toml — own Worker, separate SESSIONS KV, USERS shared with prod, own DO migrations, `MEDIA_PIPELINE=off`
- [x] §4.2 `applySessionNamespace` idempotent + `list()` namespaced (shared `src/lib/session-namespace.js`)
- [x] §4.2 commands-registry `audiences` field + one visibility helper (`src/lib/command-visibility.js`) used by /start AND setMyCommands
- [x] §4.2 `ensureCommandsRegisteredOnce` keyed by botId+digest; flag set only after a successful `await`
- [x] §4.3 webhook `secret_token` validated before any state change; `scripts/set-webhook.mjs`
- [x] §4.4 ci.yml deploy/smoke shell loop (main/recruiter/freelance); freelance INERT without `FREELANCE_BOT_TOKEN`
- [x] §4.5 tests: `agent-client.test.js` three audiences + new `tests/bot-audience.test.js`
- [x] `npm run check` / `npm test` / `npm run test:media-runtime` / `npm run test:staging` green
- [x] CI green on PR #235 (ci + scenario-gate + deploy-staging + smoke-test-staging + staging-gate)
- [x] Merged to main (2399807); prod deploy + smoke passed (main/recruiter verified, freelance skipped — inert)
- [ ] Enable freelance env + canary on an agreed test chat (separate step AFTER merge — not in this PR)
