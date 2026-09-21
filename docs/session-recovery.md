# Visible bounded recovery

On agent downtime, ownership transfers to RetryQueue only after its durable write succeeds. It keeps the original requestId, fileRefs, session/project, profile and mode. Two attempts run at least three minutes apart, serviced by the minutely cron. The coordinator serializes cron drains; pending work never expires. Production alone imports the legacy shared-KV queue.

Each attempt announces its start and terminal reason or acknowledged acceptance. A terminal result is saved before notification, so Telegram rejection or network failure retries the notification without re-running accepted work. Receipts are retained seven days. A crash after dispatch intent but before a recorded result stops automatic resubmission and reports the ambiguity. Profile changes cancel recovery visibly. Acceptance is not task completion: the agent owns subsequent execution and results.

Bounded cost: up to two additional agent dispatches, DO requests/storage and notification retries. The initial user's notification is best effort after queue persistence. Notification outage can delay visible progress. Rollback requires retaining the RetryQueue class/binding/migration until its pending work drains; do not remove a populated durable class in a code revert.

## Changed executable contract

Owner request 2026-09-16 replaces one silent retry with two visible attempts. tests/self-heal-classb.test.js replaces the old “still down on the retry” and silent logout expectations. tests/retry-queue-kv.test.js replaces delete-before-dispatch with retain-until-result semantics. tests/recovery-durable.test.js exercises the real coordinator, handler and storage under overlapping drains, object recreation, Telegram ok:false, failed session writes after ACK, intake transfer, ambiguous dispatch and profile change. External agent/Telegram calls are mocked; no production messages or paid model calls are made by tests.

Staging migration compatibility: the shared staging worker already has v2-run-outbox from PR #103. Its unchanged RunOutbox class remains exported and its migration history is preserved only in env.staging; this change does not route new work to it or create it in production.
