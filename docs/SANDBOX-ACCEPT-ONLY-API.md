# Sandbox accept-only API (SC-SBX-01 / API-16)

This implementation is the first bounded slice of [#402](https://github.com/trained-assist/trained-assist-tg-bot/issues/402), linked to [architecture change #197](https://github.com/trained-assist/trained-agent-architecture/issues/197) and draft scenario PR [#198](https://github.com/trained-assist/trained-agent-architecture/pull/198).

## Contract

- `POST /sandbox/accept-only/requests` accepts exactly `{"text":"..."}` without login or an Authorization header.
- The route is enabled only when `TG_ACCEPT_ONLY_ENABLED=true`, `TG_ACCEPT_ONLY_ENVIRONMENT=sandbox`, and `TG_ACCEPT_ONLY_MODE=accept-only`; it also requires a known sandbox bot identity and the dedicated Durable Object binding. Both checked-in sandbox configs leave the feature flag false. Production uses a different entrypoint and is explicitly rejected when production environment/bot bindings are present.
- Request bodies are capped at 4 KiB, text at 2,000 Unicode code points, admission at 5 requests per source IP per minute and 100 requests per 24 hours globally, and each ticket at 60 event reads per minute. Source IP is hashed before storage; raw request text is stored only in the isolated accept-only Durable Object and is not logged or returned.
- A successful response is `202`, `mode=accept_only`, `executionStarted=false`, `tokenUsage=0`, a generated task/request ID, and a 15-minute random read ticket. The ticket is returned once and only its SHA-256 digest is persisted.
- `GET /sandbox/accept-only/requests/{taskId}/events?after={cursor}` requires `Authorization: Bearer <ticket>`. It returns/replays only the task's `accepted_only` event; invalid, expired, cross-task, and cross-ticket reads all return `404`.
- The platform assigns fixed `sandbox-accept-only` / `sandbox-accept-only-profile` identities. No classifier, MCP, LLM, Agent Run, Runner, Control Plane, or Telegram delivery is called. This proves API intake and ticket-scoped replay only, not task execution or full E2E.
- Idempotency keys and multi-lane lease/status are not implemented in this first slice. Accept-only admission has no downstream side effects; clients should not infer execution or exactly-once task processing.

## Local component verification

```sh
npm test -- tests/anonymous-accept-only-api.test.js
npm run check
git diff --check
```

The component test enables the route only in a synthetic local environment. No deployment, Telegram message, live ingress, or staging E2E is part of this change. The production and sandbox workers must not be enabled/deployed by this PR. Enabling a future sandbox deployment requires an explicit operator change to the flag and an isolated acceptance run recorded against the deployed revision.

## Evidence boundary

Passing these local checks verifies request limits, fail-closed configuration, zero-execution behavior, ticket isolation/expiry, replay, rate controls, and absence of input logging in the code under test. It does not verify Cloudflare deployment, Telegram delivery, Control Plane admission, Runner execution, model/token budgets, or independent end-to-end stacks. Hard execution budgets and an isolated Runner remain tracked by architecture #197 and the related Runner issues.
