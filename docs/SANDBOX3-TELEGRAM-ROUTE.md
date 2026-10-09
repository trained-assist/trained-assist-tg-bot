# Sandbox-3 Telegram gateway route

`wrangler.sandbox-tg-sandbox3.toml` declares the already deployed
`trained-assist-tg-sandbox3` / `@ptichka_status_bot` gateway with its existing
Durable Object and KV namespaces. It points to the separate
`trained-assist-cp-sandbox3` Worker. The current deployed gateway still points
to the shared Telegram UX CP; this file does not switch it by itself.

Before deploy, confirm the CP sandbox-3 SHA, its dedicated D1 and Workflow,
and an admitted `integration-sandbox3-v1` principal. Pair the gateway's
`CONTROL_PLANE_PRINCIPAL_SIGNATURE` secret with the CP's dedicated
`PRINCIPAL_SECRET_SANDBOX3`; neither value belongs in this repository. Confirm
the bounded free-only execution gate and Agent API route, then run the CP
sandbox-3 lane preflight. Record the current gateway deployment version for
rollback and verify that its existing secret names and state namespace IDs
match this config. Run
`npx wrangler deploy --dry-run --config wrangler.sandbox-tg-sandbox3.toml`;
it must bundle without a migration warning.

Deploy only this config after those checks. Verify `/health`, Cloudflare's
deployed version, protected collector state, and one uniquely marked Telegram
request through CP task, Workflow, Agent API run, persistence, and terminal
reply. A health response or accepted receipt alone is not E2E acceptance.
Keep Probability Cat, Shturman, and production bindings untouched.
