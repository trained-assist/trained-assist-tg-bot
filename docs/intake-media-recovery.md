# Failed attachment recovery

Preparation checkpoints persist source refs, transcripts and completed items before
processing later attachments. A failure never launches a partial batch. Three failed
preparations move the entire batch to a separate `failed:<uuid>` record in the same
chat's Durable Object. New messages remain usable. No failed batch is auto-launched.

Operational recovery uses existing agent bearer authentication on the correct bot:

1. GET `/debug/intake/<chatId>` lists archive ids, failed message id/status and item
   summaries, without message contents. Follow `failedBatchesNextCursor` via `?cursor=`
   when present. No records are truncated or silently deleted.
2. After resolving the upstream problem, POST `/debug/intake/<chatId>/restore` with
   JSON `{ "id": "<uuid>" }`. Restore is atomic, refuses a busy run or existing retry
   batch, and never sends messages or launches an agent. A regular explicit launch
   then consumes the restored batch. Existing fresh input remains separate.

Archives keep text/references and existing file pins until restored and accepted.
This trades retained storage for recoverability; no extra LLM/STT calls are added.
Telegram transcript delivery still has the existing send/ack crash window (Telegram
has no idempotency key). An already deleted historical batch cannot be recovered by
this change. A screenshot alone cannot identify the historical upstream error.

Validation replaces `drops the batch after 3 consecutive preparation failures...`
in `tests/intake-buffer.test.js`: deletion was the old anti-blocking behavior, but
loses user input. The replacement checks archive persistence, fresh-task launch,
restoration after DO recreation and explicit retry. Real DO-to-handler coverage in
`tests/intake-media-content.test.js` checks voice -> failing photo -> retry -> complete
agent input, with one STT call and one transcript notification. Tests for the new
checkpoint callback preserve the existing mode and placeholder assertions.
