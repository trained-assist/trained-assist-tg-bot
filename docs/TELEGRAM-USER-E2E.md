# Telegram user-originated end-to-end test

Use this procedure when the question is whether the product works for a person
who sends a message to the bot. A signed fixture sent directly to `/webhook`, a
Worker `/health` response, and a local Durable Object test are useful component
checks; none of them proves that a real Telegram user's message reached the
deployed bot and got a visible response.

## Before sending

1. Confirm the test Worker deployment/version and the sandbox bot username with
   the owner of the test environment. Open the bot from the actual Telegram user
   account that is allowed by the test profile. Verify the recipient in the chat
   header; for the current sandbox that is `@probability_cat_bot`.
2. Start Cloudflare Worker logs for that same service with `npx wrangler tail
   trained-assist-tg-ux-sandbox`. Keep the stream open before sending. The logs
   are corroborating ingress evidence, not a substitute for the user's chat.
3. Send one ordinary, harmless text with a unique marker, for example:
   `USER-E2E-<date-time>: reply only “received”; do not start a task.` Do not use
   launch words, callbacks, attachments, voice messages, or sensitive content
   in the basic ingress test.

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
- the bot says the stop is still unconfirmed, acknowledges that it retained the
  text, and says it did not start another task;
- the collector exposes no launch action while the stop remains unresolved;
- no second CP admission or parallel task is created;
- the unresolved launch/stop evidence remains intact.

Failing behavior is a response such as “Предыдущая порция ещё сверяется с
запуском, поэтому текст пока не добавил” or “Связь с исполнителем потеряна”
when the user's new text is not retained. Capture the outgoing user message and
the bot reply in Telegram, plus redacted Worker/collector state, then fix the
bug and repeat the same user-originated scenario after deploying the fix.

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
