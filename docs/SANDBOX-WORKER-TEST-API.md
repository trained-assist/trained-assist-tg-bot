# Sandbox Worker test API

The probability sandbox Worker exposes `/operator/test-update` so automated
tests can submit the same message or button callback shape handled by the
Telegram webhook. It internally signs the update and dispatches it through the
normal sandbox webhook; it does not create a second bot implementation. The
operator API is enabled only in the isolated sandbox Worker. Use it as the
default sandbox E2E client: submit input over HTTP, read bot messages and
buttons from JSON, then submit a returned button callback the same way.

Use the existing `TG_SANDBOX_CLEANUP_TOKEN` bearer secret. Task execution
requires a real sandbox `chatId` on each request or the `TG_SANDBOX_E2E_CHAT_ID`
Worker variable. The update and eventual answer go to that chat. The synthetic
operator identity is `900000236`. The separate `/operator/test-buffer-message`
contract check uses the reserved fixture chat `-1000000000236`; never use that
fake destination for agent runs. The operator API accepts only the sandbox
lane's configured/open chats. It accepts `message` updates with `text`, or
`callback` updates with `callbackData`; `messageId` is optional and defaults to
the current collector button message when one exists. Captured transcript messages include
a local `messageId`; captured inline keyboards include their `callbackData`.
The response also includes a small `collector` snapshot with busy,
pending count, current collector message ID, and CP receipt counters. For
asynchronous agent runs, normal sandbox delivery sends the final answer to the
same real chat; inspect CP task state and Worker tail without opening Telegram.

Example message:

```sh
curl --fail-with-body -sS https://trained-assist-tg-ux-sandbox.skillset-apply.workers.dev/operator/test-update \
  -H "Authorization: Bearer ${TG_SANDBOX_CLEANUP_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data '{"target":"sandbox","chatId":123456789,"type":"message","text":"/adduser e2e_worker_fixture Worker Fixture"}'
```

Read `transcript[].messageId` and `transcript[].buttons` from the response when
present. For the asynchronous collector prompt, omit `messageId`; the Worker
uses the current collector message ID from Intake state.

Example callback:

```sh
curl --fail-with-body -sS https://trained-assist-tg-ux-sandbox.skillset-apply.workers.dev/operator/test-update \
  -H "Authorization: Bearer ${TG_SANDBOX_CLEANUP_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data '{"target":"sandbox","chatId":123456789,"type":"callback","callbackData":"intake_run"}'
```

Optional `updateId` and message `messageId` fields let tests choose fixture
IDs. Omit them for automatic IDs. Do not replay an update as a retry: this
endpoint exercises webhook ingress and does not promise idempotency for
synthetic updates.

Before clearing the sandbox, the reset workflow checks the paired Control Plane
database for active tasks, executions, deliveries, or pending input. It then
clears every sandbox session and Intake buffer. A saved `launching` checkpoint
blocks cleanup while its dispatch is in flight; if it has remained unresolved
for 15 minutes and the Control Plane preflight is empty, the sandbox reset
clears that stale checkpoint along with the rest of the test state. Production
Intake state does not use this reset path.

Sandbox user records use the existing `user:` keys in the isolated sandbox KV
and are removed by the full sandbox reset (which also clears older
`sandbox-user:` fixtures). The message/callback endpoint is operator-only;
it adds the fixed synthetic actor and chat to the normal webhook's allowlists
for that internal dispatch only. Production Worker routing is unchanged.
