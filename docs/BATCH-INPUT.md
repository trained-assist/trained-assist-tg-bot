# One task, one input

Owner request 2026-09-25 supersedes fresh acknowledgement per message (2026-09-15) and deletion of collector at launch (2026-09-22).

- Receipt debounce: 1500ms of quiet, distinct from existing three-minute automatic launch gate.
- One collector is edited in place; sorted Telegram message ids determine input order.
- No per-message quick-answer bypass or success transcript receipts inside a batch.
- Draft inspection uses the same assembler as dispatch. Unprocessed attachments are explicitly pending.
- Immediately before dispatch, store the complete actual /run body and ordered source items as immutable chunked DO data, scoped to bot/chat/topic and profile. Retries reuse that body. Later additions use a new request id.
- Check Input sends a private text attachment, never publishes user input publicly.
- Snapshot storage adds durable writes and retained input metadata per run; files remain references to existing storage, not duplicate binary uploads. No automatic expiry in this revision.
- Journal opens the existing authenticated session history UI. Full tracing expansion remains separate from input inspection.

Required tests replace old per-message receipt expectations with quiet-window, edit-in-place and single-launch assertions; maintain gate, media-loss, retry, topic isolation checks. Add snapshot wire equality, immutability, profile authorization and oversized payload tests.

Superseded tests (replaced in the same change):
- `tests/intake-buffer.test.js`: fresh per-message ACK, deletion at launch, plain ACK fallback → delayed single receipt, in-place reuse, durable retry without duplicates.
- `tests/intake-conversation.test.js`: immediate envelope per arrival → one envelope per quiet window; preserves one dispatch for the full conversation.
- `tests/intake-preflight.test.js`: quick hit consumes an individual buffered item → no intermediate quick dispatch; duplicate update stays deduplicated.
- `tests/media-jobs.test.js` and `tests/forum-topics-routing.test.js`: immediate media/held ACK → delayed receipt, preserving topic address.
- `tests/callbacks.test.js`: busy launch now acknowledges the callback without producing a second status bubble.
- Empty-launch tests retain no-message invariant; the callback no longer strips the keyboard asynchronously, because it races the new persistent controls.
Replacement scenario `tests/input-snapshot.test.js` is mandatory in staging. It verifies exact wire payload, immutable retries, source metadata/order, Unicode chunks, ownership, callback delivery and delayed-send concurrency.
