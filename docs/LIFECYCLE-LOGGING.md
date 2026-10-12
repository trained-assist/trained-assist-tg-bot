# Lifecycle log events

The gateway emits allowlisted JSON lifecycle events when `BUILD_SHA` is present
(deployed Workers) or `LIFECYCLE_LOGS=true` is explicitly set. The formatter
drops unknown fields, user/chat identity, message content, and exception text.

| Event | Meaning | Correlation |
|---|---|---|
| `tg.cp.snapshot_started` / `tg.cp.snapshot_persisted` / `tg.cp.snapshot_failed` | Gateway began freezing input and whether the Intake snapshot was persisted and matched its request/profile scope | `requestId` |
| `tg.cp.intake_failed` / `tg.cp.receipt_read_failed` / `tg.cp.receipt_persist_failed` | Which acceptance/receipt boundary failed; reason code contains no provider response body | `requestId` |
| `tg.cp.task_accepted` | CP returned a durable task receipt and the gateway validated it | `requestId`, `taskId`, duplicate flag |
| `tg.cp.route_completed` | The gateway received a route response from CP | `requestId`, `taskId`, optional route/reason code |
| `tg.cp.route_pending` | Route acknowledgement was unavailable; the task receipt remains durable | `requestId`, `taskId` |
| `tg.agent.run_finished_received` | Gateway received the agent callback; this alone does not prove CP result persistence | `requestId`, optional `taskId` and `generation` |
| `tg.delivery.accepted` | Telegram returned a provider message ID | `deliveryId`, optional `taskId`, provider message ID |
| `tg.delivery.rejected` | Telegram did not return a provider message ID | `deliveryId`, optional `taskId`, stable reason code |
| `tg.dispatch.failed` | Webhook dispatch threw before the handler completed | Telegram `update_id` as correlation ID, stable reason code |

`status` and `outcome` describe only the named boundary. For example,
`tg.agent.run_finished_received` is not a result-persistence receipt, while
`tg.delivery.accepted` proves Telegram accepted that message. CP persistence and
Runner process outcome remain authoritative in their owning services. Events are
best-effort operational logs, not a durable journal; repeated events can occur
on retries and should be deduplicated by correlation ID plus event and timestamp.
