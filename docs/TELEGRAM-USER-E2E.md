# Telegram user-originated end-to-end test

Use this procedure when the question is whether the product works for a person
who sends a message to the bot. A signed fixture sent directly to `/webhook`, a
Worker `/health` response, and a local Durable Object test are useful component
checks; none of them proves that a real Telegram user's message reached the
deployed bot and got a visible response.

## Before sending

### Deploying the isolated probability sandbox

To deploy the exact `main` revision to the probability test bot, use the
GitHub Actions workflow **Deploy Telegram sandbox** with branch `main` and
target `probability-sandbox`. The target defaults to `skip`; the workflow is
limited to `trained-assist-tg-ux-sandbox`, verifies Cloudflare identity before
deployment, then checks the active deployment metadata and public `/health`.
It uses the repository's `CF_API_TOKEN` and `CF_ACCOUNT_ID` secrets without
printing their values. This deploy/health check is not Telegram scenario
acceptance; continue with the lane and live-input procedure below.

1. Choose an unclaimed lane in [architecture sandbox issue #185](https://github.com/trained-assist/trained-agent-architecture/issues/185). Available ingress lanes:

   | Bot | Worker | Wrangler config |
   |---|---|---|
   | `@probability_cat_bot` | `trained-assist-tg-ux-sandbox` | `wrangler.sandbox-tg-existing-ux.toml` |
   | `@Shturman_bot` | `trained-assist-tg-shturman-sandbox` | `wrangler.sandbox-tg-shturman.toml` |

   Both gateways currently bind to the same Control Plane Worker/Task Store and
   Runner route. They are separate Telegram/chat intake lanes, not isolated
   end-to-end stacks. Claim one lane before use; if it is claimed or occupied,
   choose the other. The configured Telegram account/chat allowlist still
   applies, but a tester does not need to enter API keys or Cloudflare
   credentials into Telegram.
2. Check actual occupancy, not `/health` alone. `/health` is liveness only.
   The protected `/collector-state` reports `busy`, `buf`, `launching`,
   `retryBatch`, and unresolved CP/stop barriers. Treat the lane as occupied if
   it has an active claim, a task/launch in progress, pending buffered input,
   unresolved launch, or pending stop. Do not clear state to free a lane; ask the
   owner/engineering session to inspect it.
   The gateway's `TG_SLICE_ALLOWED_CHATS` and `TG_SLICE_ALLOWED_USERS` are
   Cloudflare secrets, not checked-in values. Do not infer the test destination
   from an old chat ID, bot token, another project, or a synthetic fixture. If
   the owner has not provided the intended chat, ask them to open the chosen
   bot's private chat and send `/start` (or a harmless unique test message).
   Then inspect the matching Worker's protected/authorized Telegram update
   evidence and confirm the received `message.chat.id` and `message.from.id`
   against the configured allowlists without printing secret values. A private
   chat ID is not a credential, but keep it in the trusted local test bindings
   unless a shared runbook genuinely needs the literal value. For a group or
   forum topic, confirm the chat ID and `message_thread_id` separately.
3. An engineering session can tail that exact Worker before sending. From the
   TG bot checkout, use the matching command:

   ```bash
   npx wrangler tail trained-assist-tg-ux-sandbox --config wrangler.sandbox-tg-existing-ux.toml
   npx wrangler tail trained-assist-tg-shturman-sandbox --config wrangler.sandbox-tg-shturman.toml
   ```

   Wrangler needs an authenticated Cloudflare operator session; the tester does
   not. I can run the tail and correlate evidence without asking the user to
   operate Wrangler. Tail logs are corroborating ingress evidence, not a
   substitute for the user's chat.
4. After confirming the destination and that it is idle, send one ordinary,
   harmless text with a unique marker, for example:
   `USER-E2E-<date-time>: reply only “received”; do not start a task.` Do not use
   launch words, callbacks, attachments, voice messages, or sensitive content
   in the basic ingress test.

## No-login HTTP test API status

The first code slice of issue #402 adds a disabled-by-default accept-only API;
see [SANDBOX-ACCEPT-ONLY-API.md](SANDBOX-ACCEPT-ONLY-API.md). It accepts and
stores a bounded synthetic request and exposes ticket-scoped receipt replay,
but does not run the classifier, Control Plane, Runner, or Telegram delivery.
Both checked-in sandbox configs keep the feature disabled, and this change does
not deploy it. This is not a full task E2E and does not replace a user-originated
Telegram test. The public `/health` route remains liveness only;
`/webhook`, `/collector-state`, and delivery routes remain protected. Never send
raw unsigned webhook updates or remove those checks.

## Evidence to collect

For the same message and timestamp, check all three layers:

1. **Telegram client:** the outgoing message appears in the intended bot chat
   under the user's account.
2. **Gateway:** the deployed Worker logs show the webhook request was handled.
   If the tail has no event, check the Cloudflare log view for the same Worker
   and time before concluding that the webhook was not delivered.
3. **User-visible result:** a new bot message appears after the test input.
   Record its exact text and whether it is an acknowledgement, a refusal, or a
   task result. A generic error response is evidence of a broken user path even
   when the Worker accepted the webhook.

When diagnosing intake state, use the test environment's existing protected
collector-state tooling and verify the unique message was stored exactly once.
Keep its authorization material in the trusted local secret store; never put it
in chat, a shell transcript, a screenshot, a test fixture, or this document.
Check that a harmless ingress test did not call CP admission or start a task.
Do not clear a pending/unknown launch as part of the test: preserve that state
until its owner has reviewed the evidence.

## Regression for a stuck pending launch/stop window

Run this only against the sandbox chat while its admission/stop window is known
to be unresolved. Send one normal text message from Telegram. Passing behavior:

- the message is visibly stored in the held input (once);
- the bot says the stop is still unconfirmed and confirms that it retained the
  text as a separate draft;
- a fresh collector anchored to the latest input offers explicit work-style
  actions; the previous collector is neutralized and stale revision callbacks are
  rejected;
- an explicit tap creates exactly one independent CP admission in a fresh session;
- the old task's unresolved stop evidence remains unchanged, and the old task is
  not re-admitted or resumed;
- duplicate/stale taps do not create another admission;
- the unresolved launch/stop evidence remains intact.

The independent launch is opt-in. Ordinary text is held and never starts a
second task automatically. A button launch must not poll, clear, or release the
old stop window; its task uses a distinct session while reconciliation continues.

Failing behavior is a response such as “Предыдущая порция ещё сверяется с
запуском, поэтому текст пока не добавил” or “Связь с исполнителем потеряна”
when the user's new text is not retained, or a status points to an older
collector while the latest input has no visible button. If Telegram collector
delivery is unknown, the bot must say it could not show the launch button and
did not launch the draft. Capture the outgoing user message and bot reply in
Telegram, plus redacted Worker/collector state, then fix the bug and repeat the
same user-originated scenario after deploying the fix.

## Record

Record the date, Worker version, bot username, sender account label, unique
marker, observed user-visible reply, ingress-log result, stored-once result,
and whether CP admission occurred. Do not record credentials or unrelated chat
history. A screenshot may support the record, but should be cropped to the test
chat and sanitized before sharing.

### 2026-10-06 manual reproduction

The owner-authorized Telegram Desktop session sent a harmless plain-text
message to the sandbox bot while the stuck pending-stop state was present. The
bot replied with the same “Предыдущая порция ещё сверяется с запуском…” refusal
seen by the user. This confirms the failure on the actual user route; a separate
synthetic webhook or health check would not have exposed that user-visible
failure. The test input was affected by the desktop's Russian keyboard layout,
so this run is evidence of the refusal/route, not a content-integrity check.

### 2026-10-06 post-fix verification

After deploying sandbox version `1ec2e525-f8ef-4119-8c29-4c34c62fad20`, a new
harmless text was sent from the same Telegram Desktop user session. `wrangler
tail` recorded `POST /webhook` and `POST /intake/append` as `Ok`. The bot replied:
“Остановка задачи ещё не подтверждена. Текст сохранил в отложенной порции; новый
запуск не выполнял.” The desktop's Russian keyboard layout transformed the
Latin test marker, so this run verifies the pending-stop flow and visible
acknowledgement, not exact input text. The signed Workerd/SQLite regression
checks the exact stored text, once-only admission, no debounce and no CP launch.

### 2026-10-08 pending-stop callback re-reproduction

After the fresh collector fix was deployed to `@probability_cat_bot`
(`trained-assist-tg-ux-sandbox`, version
`45fb884f-6f47-4474-91fd-5580d35cd4b5`, source SHA
`718c1b06903e1b7d4cc35bdefd4cf6921b537a1b`), the owner sent the harmless text
`12345` and tapped the visible “Изучи и задай вопросы” action. The bot retained
the draft and showed “Передача не подтверждена — используй текущее сообщение.”
The live Wrangler tail recorded `/webhook`, `/intake/snapshot`,
`/intake/append`, `/intake/callback-owner`, and `/intake/flush`. This proves the
real Telegram update reached the deployed Worker and that callback processing
reached the final launch endpoint; it does not prove a CP admission. No launch
request followed the refusal in the captured trace, and the pending old-stop
state was not cleared.

The callback preflight passes before `/intake/flush` is called. The final
endpoint has multiple refusal guards that currently collapse to the same
non-2xx response (`Callback ownership mismatch`), so Wrangler's tail cannot
identify which guard rejected this click. Historical Cloudflare Observability
querying with the local Wrangler token returned HTTP 403. The precise final
guard remains unconfirmed; follow-up issue
[#477](https://github.com/trained-assist/trained-assist-tg-bot/issues/477)
tracks reason-coded diagnostics. Do not infer that the draft was launched from
the callback ACK or from a successful Worker invocation line: confirm a CP
admission separately before reporting launch success.

The diagnostic implementation now under review emits `tg.intake.callback_refused`
or `tg.intake.launch_refused` with only a `reasonCode` (and the static endpoint
path for callback refusal). Possible codes include `callback_in_flight`,
`callback_no_longer_owned`, `dispatch_in_progress`,
`unresolved_launch_scope_changed`, and `pending_stop_requires_parallel`. The
gateway mirrors the code as `tg.callback.launch_refused`; these events contain
no message text, chat ID, user name, or callback payload. The live reason is
still pending deployment to the probability sandbox and one tap on its already
retained draft.
