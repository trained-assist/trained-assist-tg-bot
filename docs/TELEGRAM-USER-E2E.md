# User end-to-end test

Use the Worker test API for routine sandbox user scenarios. It submits a
Telegram-shaped update through the deployed sandbox Worker's signed webhook
handler, using the test account's real `chatId` and `userId`. With
`delivery:"telegram"`, normal bot replies and the final answer go to that real
chat while immediate replies are also returned in the operator transcript.
This exercises intake, Control Plane, runner, and delivery without using the
Telegram UI.

Use the manual Telegram procedure below only when the question specifically
concerns Telegram's own webhook ingress or client behavior. `/health` proves
liveness only.

## Before sending

### Deploying the isolated probability sandbox

To deploy the exact `main` revision to the probability test bot, use the
GitHub Actions workflow **Deploy Telegram sandbox** with branch `main` and
target `probability-sandbox`. The target defaults to `skip`; the workflow is
limited to `trained-assist-tg-ux-sandbox`, verifies Cloudflare identity before
deployment, then checks the active deployment metadata and public `/health`.
It uses the repository's `CF_API_TOKEN` and `CF_ACCOUNT_ID` secrets without
printing their values. After deployment, require
`node tools/sandbox-buffer-cycle.mjs inspect` to report both CP and Telegram
buffers empty before a scenario. The deployment workflow also runs buffer
contract checks and resets state after them.

### Deploying the isolated sandbox3 Worker

Use the manual workflow **Sandbox3 Telegram worker E2E** from protected `main`
with `run_e2e=true`. It verifies the Cloudflare account and pinned test-user
ID, deploys only `trained-assist-tg-sandbox3` with ingress and delivery paused,
checks the isolated CP lane and existing V1 delivery-owner state, and clears
CP plus Telegram intake state before enabling traffic. It then exercises help,
status, anonymous login guidance, message aggregation, temporary profile login,
one real Runner answer, and delivery into the pinned sandbox Telegram chat.
The workflow cleans CP and Telegram intake state after the task reaches a
terminal result and uploads sanitized evidence. It does not use the Telegram UI
or deploy any production Worker.

The sandbox3 deploy config preserves its existing `IntakeBuffer` and
`TgDeliveryOwner` SQLite namespaces. It does not apply a Durable Object
migration. The sandbox3 test destination is the tester's private chat. Before
the first real-delivery E2E, the tester must open `@ptichka_status_bot` and send
`/start` once; Telegram does not allow a bot to initiate a private conversation.
The workflow pins the dedicated chat ID and sender ID to the same tester-owned
account. Operator token and test chat/user IDs are separate Worker secrets.
To inspect the same state locally, set
`TG_SANDBOX_TARGET=sandbox3` and use `TG_SANDBOX3_OPERATOR_TOKEN` with
`tools/sandbox-buffer-cycle.mjs inspect|reset`.

1. Use the isolated probability sandbox for the standard user journey:

   | Bot | Worker | Wrangler config |
   |---|---|---|
   | `@probability_cat_bot` | `trained-assist-tg-ux-sandbox` | `wrangler.sandbox-tg-existing-ux.toml` |

   Both gateways share the sandbox Control Plane and runner. Use the tester's
   explicitly provided real chat and sender IDs; never reuse an old ID or the
   reserved fake buffer-test destination. Keep literal IDs in local test
   bindings, not in shared docs.
2. Check occupancy with `node tools/sandbox-buffer-cycle.mjs inspect`, not just
   `/health`. Do not reset while CP reports active work. After a task is
   terminal, reset the sandbox with `node tools/sandbox-buffer-cycle.mjs reset`
   and verify both stores empty before starting the next scenario.
3. Tail that exact Worker while the scenario runs. From the TG bot checkout,
   use the matching command:

   ```bash
   npx wrangler tail trained-assist-tg-ux-sandbox --config wrangler.sandbox-tg-existing-ux.toml
   npx wrangler tail trained-assist-tg-shturman-sandbox --config wrangler.sandbox-tg-shturman.toml
   ```

   Wrangler needs an authenticated Cloudflare operator session; the tester does
   not. The HTTP test API and exact request examples are documented in
   [SANDBOX-WORKER-TEST-API.md](SANDBOX-WORKER-TEST-API.md).

## Worker test API modes

`/operator/test-update` is owner-authenticated and mounted only in the isolated
sandbox Worker. It dispatches a Telegram-shaped update through the same signed
webhook handler. `delivery:"capture"` is the default for contract checks and
suppresses sends. `delivery:"telegram"` keeps normal delivery on and tees
immediate replies into the response; use it for task scenarios. `userId` binds
the session to the real test account. Operator requests can exercise sandbox
user management without changing Worker configuration. Never expose the
operator endpoint in production or remove the webhook signature check.

## Evidence to collect

For each Worker-driven scenario, check these layers:

1. **Worker:** the API accepted each message/callback and the tail shows intake
   admission, CP receipt, and delivery-owner enqueue/drain/load.
2. **Control Plane:** one durable task contains the submitted input, its
   execution reaches terminal success, and the saved result matches the request.
   For the sandbox3 Telegram route, CP output has `delivery_state='not_required'`
   with no CP delivery rows: the sandbox Intake delivery owner owns Telegram
   sends. This matches the CP stop-window contract; a CP delivery row is not
   evidence of the gateway's external Telegram acknowledgement.
3. **Delivery:** the Intake barrier clears only after the delivery owner reports
   the terminal Telegram message as sent to the pinned chat and supplies a
   Telegram provider message ID. Immediate replies include Telegram's accepted
   message IDs in the API transcript; verify the final answer through the CP
   result and delivery-owner/Intake completion path.

When diagnosing intake state, use the protected operator API and verify each
unique message was stored exactly once.
Keep its authorization material in the trusted local secret store; never put it
in chat, a shell transcript, a screenshot, a test fixture, or this document.
After each terminal scenario, reset the sandbox and verify both stores empty
before beginning the next one. The manual **Reset and test sandbox intake
buffers** GitHub Action runs reset → empty-state preflight → fresh-message
aggregation test → reset, and uploads count-only evidence. If a launch remains
active or unknown, reset preflight refuses; preserve that state until
reconciliation makes it terminal.

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

### 2026-10-11 sandbox3 baseline: help, intake, login, answer and delivery

GitHub Actions run [38101728592](https://github.com/trained-assist/trained-assist-tg-bot/actions/runs/38101728592)
passed against the isolated sandbox3 lane. It began with empty CP and Telegram
intake stores, checked `/help`, status and anonymous-login prompt, aggregated a
fresh two-message input, then logged in the pinned test profile and submitted a
question. Communication selected the agent route (`COMMUNICATION_SELECTED`);
the CP task completed, exactly one Runner execution succeeded, and its answer
matched the run's challenge. The sandbox3 Intake delivery owner reported one
terminal Telegram send to the pinned test chat with a provider message ID.
CP correctly reported `delivery_state='not_required'` and zero CP delivery
rows. Both stores were empty again after cleanup. The run used CP build
`0c1e9c5a2d88f8c3a3aa297d9cd5ddf19edb7b67` and Worker source
`a292739a68fe65038ccb5ba6c9b82151d4b1c85a`.

This confirms the basic authenticated question-to-answer path on sandbox3; it
does not certify the remaining user scenarios or production.

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

### 2026-10-10 Worker-driven user scenarios

After PR [#509](https://github.com/trained-assist/trained-assist-tg-bot/pull/509)
was merged and sandbox deploy run `38066516981` passed, the owner-authenticated
Worker API was exercised in `delivery:"telegram"` mode for `@kobzevvv` against
`@probability_cat_bot`:

- Created a temporary sandbox login, authenticated it using the supplied
  Telegram sender ID, submitted `Reply with exactly this word: READY.`, and
  launched through the Worker's normal intake route. CP recorded one terminal
  `done` task and a successful `cloudflare-workflows` execution; its result
  matched `READY`. The delivery owner completed the terminal send before Intake
  released its busy barrier.
- Submitted two messages (`The task has two parts.` and `Reply only with the
  exact word BATCHED.`) and launched once. A single CP task retained both parts,
  completed successfully, and returned a result containing `BATCHED`. Intake
  returned to idle after delivery.
- Before login, `/help` and `/status` responded; a plain question prompted for
  login and left the buffer empty.

The full reset ran after both task scenarios. Final sandbox inspect reported
empty CP and Telegram buffers. The final anonymous-command check also left both
stores empty. Temporary passwords and literal chat IDs were kept out of logs
and this record.

### 2026-10-10 revision-bound work-style buttons

After PR [#511](https://github.com/trained-assist/trained-assist-tg-bot/pull/511)
merged, the sandbox was deployed from source SHA
`b0400203f8ccb4ee9dc55e8595f842c6eb8f77dc` (Worker version
`04d2bab8-877b-46bb-b3ee-a2af813fd13e`). The owner-provided test account used
the Worker API; its literal sender ID is intentionally omitted.

- With the `auto` work-style button, Worker resolved the shortcut to
  `ws|auto|1`. Intake logged one accepted CP request; CP recorded one `done`
  task and a successful `cloudflare-workflows` execution. The saved answer was
  exactly `BUTTON_OK_20261010_1639`.
- With the `answer` work-style button, Worker resolved the shortcut to
  `ws|answer|1`. CP recorded one `done` task and a successful execution; the
  saved answer was exactly `ANSWER_MODE_OK_20261010_1644`.
- In both runs, delivery-owner enqueue, drain, and load completed. A following
  `/status` reported no active task or pending input, confirming Intake had
  released its delivery barrier. The reset removed both tasks, their execution
  records, the temporary login, and all Telegram and CP sandbox state; final
  inspection reported both stores empty.

The same source SHA reached production through main's normal CI, mandatory
scenario gate, isolated staging deployment/smoke, and production smoke. The
production Worker reported that exact `buildSha`, `/debug/whoami` identified
`@super_personal_assistant_bot`, and an unsigned webhook probe returned `401`.
These are production deployment and identity checks, not a production
user-originated question/answer scenario: `/operator/test-update` is sandbox
only by design, so this run did not inject synthetic user input into the
production webhook.
