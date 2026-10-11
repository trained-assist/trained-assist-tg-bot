# Sandbox Telegram stop-window recovery

This procedure applies only to the owner-authenticated sandbox Worker and one explicitly selected chat/topic. It must never be used against a production bot. `release` only releases local Intake state after CP already reports terminal tasks; `reconcile` may call the normal CP cancel API for a previously stopped task only when every recorded run is terminal and has no lease.

The owner-authenticated `POST /operator/stop-window` route uses the separate `TG_SANDBOX_OPERATOR_TOKEN` Worker secret. The token is independent of Telegram's webhook secret. Inspect accepts `profileId`, `chatId`, and optional `threadId`; omit `windowId` to discover the current pending window. If the sandbox has exactly one configured allowed chat, `chatId` can also be omitted and the Worker resolves its own configured profile. If several chats are allowed, pass the exact `chatId`. The returned snapshot redacts message text and captions. `release` and `abandon` require the exact `windowId` returned by inspect.

`release` is allowed only when each durable admission receipt matches the selected profile/request/task, CP reports the same task as terminal (`done`, `failed`, or `cancelled`), every run is terminal with no lease, and awaiting input is closed. Any missing, conflicting, active, unknown, or unavailable evidence returns an explicit refusal and leaves the selected conversation unchanged. A successful release retains the draft and emits a fresh collector with the normal launch button.

`reconcile` requires `confirmWindowId` to match the inspected window. It handles the narrow case where `/stop` already left the selected CP task active even though all its runs are terminal and lease-free. For each matching durable receipt, the Worker first reads CP status; if the task is still active with at least one run, all runs terminal, and awaiting input closed, it invokes the ordinary CP `/cancel` API. It then reads status again and releases the local stop barrier only after CP confirms a terminal task and all runs remain terminal and lease-free. An active/unknown run, lease, missing receipt, unavailable CP, or unconfirmed cancel leaves the Intake state untouched. This is an operator recovery for sandbox fixtures, not a way to skip run termination evidence.

`abandon` requires `confirmWindowId` equal to the inspected `windowId` and `auditReason: "sandbox_test_fixture_abandoned"`. It records the redacted pre-reset snapshot under the window-specific audit key, preserves CP receipts/launch evidence, and clears only the selected chat/topic's stale local gate. A persisted `launching` marker is eligible only after the window has been busy for at least 15 minutes; an in-memory CP dispatch always blocks abandonment. It does not mark tasks terminal or cancel them. The bot warns that the old task may still run, preserves the draft, and offers its normal explicit launch button. Do not use this path for a production incident or if the owner has not accepted possible overlap with the old task.

Example request bodies (never put the bearer token in source control or chat):

```json
{"mode":"inspect","profileId":"<sandbox-profile>","chatId":123456789,"threadId":null}
```

```json
{"mode":"release","profileId":"<sandbox-profile>","chatId":123456789,"threadId":null,"windowId":"<exact-inspected-window>"}
```

```json
{"mode":"reconcile","profileId":"<sandbox-profile>","chatId":123456789,"threadId":null,"windowId":"<exact-inspected-window>","confirmWindowId":"<exact-inspected-window>"}
```

```json
{"mode":"abandon","profileId":"<sandbox-profile>","chatId":123456789,"threadId":null,"windowId":"<exact-inspected-window>","confirmWindowId":"<exact-inspected-window>","auditReason":"sandbox_test_fixture_abandoned"}
```

Before any Worker deployment, verify `wrangler whoami` is `typeformowner@gmail.com` / `d740a05e9442c1d0feacae2dfc673e93`. Deploy only with `wrangler.sandbox-tg-existing-ux.toml`, then verify `/health` and active deployment metadata. Never print secret values or include user text, tokens, chat IDs, or CP signatures in issues/PRs.
