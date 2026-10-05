# Telegram integration v1 live ingress smoke

Scope: [architecture #140](https://github.com/trained-assist/trained-agent-architecture/issues/140), [P11 #50](https://github.com/trained-assist/trained-agent-architecture/issues/50), existing [gateway PR #351](https://github.com/trained-assist/trained-assist-tg-bot/pull/351). Harness hardening is isolated in `integration/tg-smoke-stable-ids-20261005`; gateway source changes belong to the parent integrator.

**Live ingress and reconciliation are paused pending delivery-owner review and deployment.** Independent readback observed different Bot API message IDs for the same caps receipt and terminal delivery. A sequential harness PASS does not establish single-writer delivery safety or clear that failure. Keep the original timeout and duplicate-delivery evidence; do not rerun either case to replace it.

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
| `SMOKE_UPDATE_ID`, `SMOKE_MESSAGE_ID` | Required explicit positive 32-bit IDs for the live CLI; no random live defaults. Reserve and persist both IDs before dispatch, along with the exact update context. Reuse only for the same logical update, never a replacement after an unknown outcome. Library `readConfig` retains its optional defaults for compatibility; CLI uses `readLiveConfig`. |
| `SMOKE_TIMEOUT_MS` | Overall network/poll/replay deadline, default 120000, maximum 900000. |
| `SMOKE_REQUEST_TIMEOUT_MS` | Per-request deadline, default 60000, maximum 60000; capped by remaining overall time, including response-body parsing. The synchronous ingress may include selector/writer latency; timeout does not authorize a fresh update or task. |
| `SMOKE_POLL_INTERVAL_MS` | Default 2000, range 100–30000. |

The private `/tmp/ta-integrator-v1-runtime/client-bindings.json` currently contains principal/signature/profile and webhook secret, but lacks approved bot/chat bindings and may lack the endpoint URLs. It is a starting configuration, not permission to infer a destination. Communication-service bindings in that file are ignored.

## Run

Only after the parent explicitly clears the delivery pause, completes bot/chat authorization, and deploys the reviewed delivery owner, run with reserved IDs in the private bindings file:

```sh
INTEGRATION_BINDINGS_FILE=/tmp/ta-integrator-v1-runtime/client-bindings.json \
  node scripts/integration/telegram-v1-smoke.mjs
```

All missing required settings fail preflight before HTTP calls. Exit code `0` means complete smoke pass, `1` means failed/incomplete evidence, and `2` means configuration blocked. Output is JSON Lines: ingress acknowledgement, changed polling states, final sanitized evidence. Save stdout to an owner-approved private evidence location when needed. Keep gateway/CP/communication/runner revisions and deployment references beside the transcript; public evidence must omit machine addresses and bindings.

The harness never calls `setWebhook`, `sendMessage`, `getUpdates`, CP `/start`, `/resume`, `/recover`, or KV. Gateway reconciliation owns outbound messages, and every observed delivery must target exactly the configured test chat/thread. `/cron` reconciles the sandbox's entire outbox, so the isolated deployment must contain only approved test destinations and no unrelated pending tasks. Start with a fresh/idle conversation: an existing awaiting-input conversation may treat the text as a continuation rather than a new task. Timeout or lost ingress response is a failure, never authorization to create another task or rerun an external action; inspect the original task/update before replaying.

## Unknown acknowledgement recovery

Before dispatch, save a private checkpoint containing the reserved update/message IDs, bot identity, exact destination/thread, mapped profile, text and serialized update. Preserve the original response or timeout evidence. A 15-second ingress timeout previously hid an already completed quick task; the 60-second request default reduces premature timeout but does not make unknown outcomes safe to retry automatically.

Reconcile read-only first: the gateway dedup key is `conv:u:<updateId>`. A processed entry supplies the original task ID; inspect that task's signed CP `/status` and protected gateway `/deliveries/:taskId` without calling `/cron` or posting another update. These reads may themselves lag when backed by KV; an absent record is not proof of nonacceptance.

For a fresh direct-mode message, the original sources construct `requestId = tg:<bot>:<chat>[:<thread>]:<messageId>:u<updateId>` (`src/sandbox-tg/profile.js`, `src/sandbox-tg/worker.js`). CP `src/intake/intake-service.ts` derives `userTaskId = "ut-" + hex(SHA-256(profileId + NUL + requestId)[0:10])`. Use the actual deployed chat-profile mapping, not an assumed default profile. This formula is not valid for an awaiting-input continuation or batch launch; those require their original stored request/task identity. Compute and retain private identity fields locally; do not print chat IDs or the full request ID.

If the original task and deliveries are already complete, no ingress replay or CP reroute is necessary. Only after source/index reconciliation proves a repair is needed and the parent authorizes it may the exact same stable update be replayed. Keep its task, generation and provider IDs unchanged. Never use a new ID, text, task, or model job to supersede an unknown acknowledgement. Concurrent writers and the provider-acceptance/persistence crash gap still require delivery-owner protections; stable CLI IDs alone do not provide exactly-once outgoing delivery.

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

Current live status: **paused after observed duplicate outgoing delivery; acceptance not cleared**. Owner-approved bot/chat configuration does not override this pause. Local harness tests are fixtures, not live Telegram evidence, and do not prove the delivery-owner fix.

Syntax/whitespace checks:

```sh
node --check scripts/integration/telegram-v1-smoke.mjs
node scripts/integration/telegram-v1-smoke.mjs --help
git diff --check -- scripts/integration/telegram-v1-smoke.mjs docs/INTEGRATION-V1-SMOKE.md
```
