# Telegram integration v1 live ingress smoke

Scope: [architecture #140](https://github.com/trained-assist/trained-agent-architecture/issues/140), [P11 #50](https://github.com/trained-assist/trained-agent-architecture/issues/50), existing [gateway PR #351](https://github.com/trained-assist/trained-assist-tg-bot/pull/351). Harness and documentation belong to `integration/first-working-version-20261005`; gateway source changes belong to the parent integrator.

This harness posts an authorized Telegram-shaped update to the deployed sandbox's real `/webhook` handler, repeats the **identical serialized body**, checks the same `userTaskId`, polls signed CP `/status`, and drives protected gateway `/cron`. It requires a stored terminal delivery with `status=sent` and `providerMessageId`. A second reconciliation must preserve delivery IDs, provider message IDs, attempts, task generation, and run IDs.

Injected ingress proves the gateway path. It does **not** prove an incoming message sent by a human through Telegram. That separate #140 acceptance check requires the owner's authorized test bot/chat and a genuine user message. A bot's `sendMessage` does not create a user inbound update. Bot API acceptance does **not** prove human reading.

## Bindings and isolation

Node.js 20+; no added packages. Run from this checkout with its matching sandbox source. The deployed gateway must use `src/sandbox-tg/index.js`, direct mode, separate sandbox bot, isolated KV, authorized test chat, real `https://api.telegram.org`, and the intended deployed CP. `/health` verifies bot username and mode; optional `getMe` verifies the supplied token's identity. Health and delivery summaries cannot independently attest the deployed Telegram API base: operator configuration/source evidence is required to rule out an emulator.

The harness reads only environment variables and an optional flat private JSON object selected by `INTEGRATION_BINDINGS_FILE`. Environment values override file values, including empty values. The file must have no group/other permission bits (`chmod 600`). Never commit it, use shell tracing, paste its contents, or put secrets in CLI arguments. It never prints raw responses, answer text, URLs, chat/user identity, tokens or signatures; failures contain only controlled labels/status codes. HTTP redirects are refused to avoid forwarding credentials elsewhere.

| Binding | Requirement |
| --- | --- |
| `GATEWAY_URL` | Required deployed sandbox HTTPS base URL; no query, fragment or URL credentials. |
| `TELEGRAM_WEBHOOK_SECRET` | Required secret shared with the gateway. Sent only in `x-telegram-bot-api-secret-token`. |
| `TEST_CHAT_ID`, `TEST_USER_ID` | Required owner-approved numeric test destination and human sender ID; no fallback identity. |
| `TG_SLICE_ALLOWED_CHATS` | Required comma-separated deployed allowlist; must include `TEST_CHAT_ID`. The gateway independently authorizes it. |
| `TG_SANDBOX_BOT_USERNAME` | Required expected sandbox identity; production identities from sandbox config are refused. |
| `CONTROL_PLANE_URL` | Required deployed CP HTTPS base URL. |
| `CONTROL_PLANE_PRINCIPAL` | Required same principal as the gateway. |
| `CONTROL_PLANE_PRINCIPAL_SIGNATURE` | Required precomputed 64-character hex HMAC-SHA256; sent as `x-principal-sig` alongside `x-principal`. No root signing secret needed. |
| `CONTROL_PLANE_PROFILE` | Required intended CP profile; account for a deployed per-chat profile override. Checked when CP exposes `profile_id`; current raw status omits it and authorizes task access by principal. |
| `CONTROL_PLANE_API_KEY` | Optional additional CP bearer authentication. |
| `TG_SANDBOX_BOT_TOKEN` | Optional; used **only** for read-only `getMe` against real Telegram. Gateway owns outgoing delivery credentials. |
| `TEST_CHAT_TYPE` | Optional `private`, `group`, or `supergroup`; defaults to private for positive chat IDs, supergroup for negative IDs. |
| `TEST_THREAD_ID` | Optional positive forum topic ID; requires supergroup. Delivery must match this thread. |
| `SMOKE_TEXT` | Optional exact task text, default `Каково состояние системы?`; use an approved request with no unrelated external effects. |
| `SMOKE_UPDATE_ID`, `SMOKE_MESSAGE_ID` | Optional positive 32-bit IDs; random defaults, reported as evidence. Reserve IDs against real Telegram traffic. Reuse an update ID only to replay that same logical update. |
| `SMOKE_TIMEOUT_MS` | Overall network/poll/replay deadline, default 120000, maximum 900000. |
| `SMOKE_REQUEST_TIMEOUT_MS` | Per-request deadline, default 15000, maximum 60000; capped by remaining overall time, including response-body parsing. |
| `SMOKE_POLL_INTERVAL_MS` | Default 2000, range 100–30000. |

The private `/tmp/ta-integrator-v1-runtime/client-bindings.json` currently contains principal/signature/profile and webhook secret, but lacks approved bot/chat bindings and may lack the endpoint URLs. It is a starting configuration, not permission to infer a destination. Communication-service bindings in that file are ignored.

## Run

After the owner completes bot/chat rotation and the parent provisions the bindings and deploys the delivery route, run:

```sh
INTEGRATION_BINDINGS_FILE=/tmp/ta-integrator-v1-runtime/client-bindings.json \
  node scripts/integration/telegram-v1-smoke.mjs
```

All missing required settings fail preflight before HTTP calls. Exit code `0` means complete smoke pass, `1` means failed/incomplete evidence, and `2` means configuration blocked. Output is JSON Lines: ingress acknowledgement, changed polling states, final sanitized evidence. Save stdout to an owner-approved private evidence location when needed. Keep gateway/CP/communication/runner revisions and deployment references beside the transcript; public evidence must omit machine addresses and bindings.

The harness never calls `setWebhook`, `sendMessage`, `getUpdates`, CP `/start`, `/resume`, `/recover`, or KV. Gateway reconciliation owns outbound messages, and every observed delivery must target exactly the configured test chat/thread. `/cron` reconciles the sandbox's entire outbox, so the isolated deployment must contain only approved test destinations and no unrelated pending tasks. Start with a fresh/idle conversation: an existing awaiting-input conversation may treat the text as a continuation rather than a new task. Timeout or lost ingress response is a failure, never authorization to create another task or rerun an external action; inspect the original task/update before replaying.

## Parent gateway contract

`GET /deliveries/:taskId` uses the same webhook-secret header as `/webhook` and `/cron`. The parent gateway reads its own KV delivery records, authorizes each record's destination against its deployed allowlist, and returns:

```json
{
  "receipt": {
      "deliveryId": "receipt:request-id",
      "userTaskId": "task-id",
      "status": "sent",
      "attempts": 1,
      "providerMessageId": 101,
      "chatId": 123,
      "threadId": null
    },
  "terminal": {
      "deliveryId": "terminal:task-id:g0",
      "userTaskId": "task-id",
      "status": "sent",
      "attempts": 1,
      "providerMessageId": 102,
      "chatId": 123,
      "threadId": null
    }
}
```

`providerMessageId` projects the existing stored `telegramMessageId` produced by the Telegram client's successful Bot API response. Return `receipt: null` / `terminal: null` while records are not yet available. The parent route selects the current CP generation's terminal key. The harness also accepts a flat `deliveries[]` envelope. No message text, tokens, raw provider errors or KV access is exposed. Receipt IDs begin `receipt:` or use the legacy task ID; the final ID must be `terminal:<userTaskId>:g<CP generation>`. Numeric/string provider IDs are accepted if positive safe integers. Duplicate `/webhook` responses must expose the dedup record's original `userTaskId`, as well as `ok=true, duplicate=true`. Receipt notification evidence is reported independently and is not required for final-delivery success; an absent receipt summary remains `unverified`. The parent should look up new `receipt:<requestId>` records as well as legacy task-ID records to expose that evidence.

CP is queried using raw `POST /status {"taskId":"..."}` with signed principal headers. The harness expects `taskStore.id`, `status`, `generation`, `result` and `runs[].id`, matching the original CP `statusRow` and P11 client. If `profile_id` is supplied it must match; the current raw status projection omits that field, so principal authorization enforces task access. It requires `done` plus a nonempty string result or `result.answer`. Failed/cancelled tasks, missing final answer, exhausted delivery retries, mismatched destination, missing route, and deadline expiry are failures. Awaiting/blocked/unknown execution remains incomplete until the deadline; the harness never silently resumes it.

## Evidence and limits

| Evidence | What it establishes |
| --- | --- |
| Webhook returns stable task ID on identical update | Sequential ingress dedup at the real gateway handler. |
| `receipt=sent` | Acceptance notification sent; this is not the task result. |
| CP `done`, `result=ready` | Final answer persisted; this is not delivery. |
| Matching terminal `sent` with `providerMessageId` | Bot API accepted final delivery to the configured chat/thread. |
| Second reconciliation leaves summaries and task/runs unchanged | Replay does not resend stored delivery or restart the completed task during this observation. |
| `humanReading=unknown` | No reading/read-receipt claim. |

Concurrent ingress races, crash between Telegram acceptance and KV persistence, answer-text equality at the provider, long-message splitting, files, credentials continuation, real user inbound Telegram, Google Sheet effects, and broader #140 scenarios need separate evidence. This smoke cannot claim exactly-once delivery across those failure windows. The summaries intentionally omit answer text; acceptance is tied to the parent's terminal outbox record and its delivery implementation.

Current live status: **blocked pending owner-approved chat/bot rotation and configuration**. No live success is claimed by implementing or locally checking this harness. Contract fixtures can verify harness behavior but must be labelled as fixtures, never live Telegram evidence.

Syntax/whitespace checks:

```sh
node --check scripts/integration/telegram-v1-smoke.mjs
node scripts/integration/telegram-v1-smoke.mjs --help
git diff --check -- scripts/integration/telegram-v1-smoke.mjs docs/INTEGRATION-V1-SMOKE.md
```
