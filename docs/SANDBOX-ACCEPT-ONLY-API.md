# Sandbox accept-only API (SC-SBX-01 / API-16)

This implementation is the first bounded slice of [#402](https://github.com/trained-assist/trained-assist-tg-bot/issues/402), linked to [architecture change #197](https://github.com/trained-assist/trained-agent-architecture/issues/197) and draft scenario PR [#198](https://github.com/trained-assist/trained-agent-architecture/pull/198).

## Contract

- `POST /sandbox/accept-only/requests` accepts exactly `{"text":"..."}` without login or an Authorization header.
- The route is enabled only when `TG_ACCEPT_ONLY_ENABLED=true`, `TG_ACCEPT_ONLY_ENVIRONMENT=sandbox`, and `TG_ACCEPT_ONLY_MODE=accept-only`; it also requires a known sandbox bot identity and the dedicated Durable Object binding. It is enabled only in the Shturman sandbox config; the existing-UX sandbox keeps it disabled. Production uses a different entrypoint and is explicitly rejected when production environment/bot bindings are present.
- Request bodies are capped at 4 KiB, text at 2,000 Unicode code points, admission at 5 requests per source IP per minute and 100 requests per 24 hours globally, and each ticket at 60 event reads per minute. Source IP is hashed before storage; raw request text is stored only in the isolated accept-only Durable Object and is not logged or returned.
- A successful response is `202`, `mode=accept_only`, `executionStarted=false`, `tokenUsage=0`, a generated task/request ID, and a 15-minute random read ticket. The ticket is returned once and only its SHA-256 digest is persisted.
- `POST /sandbox/accept-only/requests/{taskId}/events` accepts a bounded JSON body `{"ticket":"...","after":0}` (maximum 512 bytes). The ticket is never sent in a request header or URL, including the internal Durable Object request; it returns/replays only the task's `accepted_only` event. Invalid, expired, cross-task, and cross-ticket reads all return `404`. Responses use `Cache-Control: no-store`.
- The Shturman sandbox config disables Cloudflare invocation logs with `observability.logs.invocation_logs=false` while keeping `[observability] enabled=true` for custom logs. The existing-UX sandbox config is unchanged. This reduces capture of request URL/headers in invocation logs; request-body confidentiality is not assumed from provider logging behavior.
- The platform assigns fixed `sandbox-accept-only` / `sandbox-accept-only-profile` identities. No classifier, MCP, LLM, Agent Run, Runner, Control Plane, or Telegram delivery is called. This proves API intake and ticket-scoped replay only, not task execution or full E2E.
- Idempotency keys and multi-lane lease/status are not implemented in this first slice. Accept-only admission has no downstream side effects; clients should not infer execution or exactly-once task processing.

## Local component verification

```sh
npm test -- tests/anonymous-accept-only-api.test.js
npm run check
git diff --check
```

The component test enables the route in a synthetic local environment. The Shturman sandbox deployment is separately verified at Worker version `7e447da8-a859-4c23-a38f-d56a41dfb3f2`; the existing-UX sandbox and production worker are unchanged. `npx wrangler deploy --dry-run --config wrangler.sandbox-tg-shturman.toml` validates configuration but is not deployment evidence.

## Evidence boundary

Passing local checks verifies request limits, fail-closed configuration, zero-execution behavior, ticket isolation/expiry, replay, rate controls, and absence of application input logging. The deployed probe verifies the Shturman endpoint and ticket-scoped replay; invocation logs are disabled for that Worker and replay tickets are absent from URLs and headers. This does not verify Telegram delivery, Control Plane admission, Runner execution, model/token budgets, or independent end-to-end stacks. Hard execution budgets and an isolated Runner remain tracked by architecture #197 and the related Runner issues.
