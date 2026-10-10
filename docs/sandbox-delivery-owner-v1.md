# Sandbox delivery owner and cutover

Parent: trained-assist/trained-agent-architecture#140. Sandbox-only; production
`src/index.js`, its outboxes, credentials and bindings are unchanged.

`TG_DELIVERY_OWNER` names a new SQLite Durable Object class `TgDeliveryOwner`.
All sandbox enqueue, drain and delivery reads use the same bot-scoped object.
KV conversation indexes remain discovery hints, never delivery state or claims.
Missing owner or cutover configuration refuses before task admission.

Initialization alone uses Durable Object `blockConcurrencyWhile`. Reads remain
available during provider I/O. An instance send queue orders drain requests, but
is not the distributed safety mechanism: transactional durable claims are.
Drain claims at most one eligible record in a storage transaction, commits
`sending` and its attempt count, then calls Telegram outside that transaction.
Successful provider IDs become immutable `sent` records. Exact enqueue replay
does not change state; conflicting payload/destination refuses.

Network failures, 5xx, malformed acknowledgements and missing provider IDs become
`unknown`, never automatic retries. A failed durable acknowledgement write leaves
`sending`, which cannot drain; owner restart durably converts it to `unknown`.
This intentionally sacrifices automatic delivery progress when acceptance is
ambiguous. It does **not** promise Telegram exactly-once effects or recovery of a
lost provider acknowledgement. There is no unknown-to-pending repair endpoint.
Only an explicit Telegram `ok:false` / HTTP429 / error_code429 rejection permits
retry after a bounded delay (at most one hour), up to the configured attempt cap.
Other rejections conservatively remain unknown. No delivery failure reruns CP.
Provider fetch rejects redirects: HTTP307/308 must not replay a POST or turn a
redirected 429 response into safe retry authority. Redirects remain unknown.
The transport uses `redirect:"manual"` and rejects 3xx before parsing responses;
workerd does not support `redirect:"error"`. There is no follow or retry fallback.

## Mandatory operator cutover manifest

Keep the test bot webhook paused without dropping updates, wait for bounded
in-flight gateway/provider work to quiesce, and keep sandbox `crons = []`.
Inventory **all pre-cutover task IDs** from authoritative CP history and all known
legacy outgoing receipt/terminal/unknown IDs. KV absence is not proof of no prior
send. Include independent provider evidence where the KV record lost a race.
Inventory completeness and quiescence are operator attestations, not proven by
this code. No worker automatically scans/imports/resends old KV deliveries.

Provision trusted `TG_SLICE_DELIVERY_CUTOVER_MANIFEST` outside model configuration:

```json
{
  "version": "tg-delivery-cutover-v1",
  "botUsername": "probability_cat_bot",
  "profileId": "integration-v1",
  "cutoverId": "operator-reviewed-snapshot-1",
  "cutoverAt": 1790000000000,
  "oldTaskIds": ["ut-old"],
  "deliveries": [{
    "deliveryId": "terminal:ut-old:g1",
    "userTaskId": "ut-old",
    "destination": {"chatId": 123, "threadId": null},
    "priorStatus": "sent",
    "providerMessageId": 1365,
    "attempts": 1,
    "history": [{"at": 1789999999000, "status": 0}],
    "observedProviderMessageIds": [1365, 1366]
  }]
}
```

Example metadata only; substitute exact operator evidence, not guessed IDs or
timestamps. Profile/bot must equal configured sandbox bindings. At most 64 KiB,
256 unique task IDs and 256 unique deliveries; every delivery task must be in
`oldTaskIds`. Destinations must be allowlisted. Provider ID may be null; attempts
are 0..20. Optional history and observed-provider-ID arrays contain at most 20
safe metadata entries. Unknown keys, malformed scope, duplicates or future
cutover time refuse. Do not truncate an oversized inventory to satisfy limits.

Initialization atomically installs old-task tombstones, quarantined records and
an immutable canonical manifest marker/digest. Old status, provider ID and history
remain evidence only, never send authority. Old-task tombstones also quarantine
later candidate IDs, even with fresh-looking timestamps or empty/stale KV.
New candidates require an original task acceptance timestamp at/after cutover;
missing, pre-cutover or future timestamps quarantine. Clock disagreements may
therefore refuse legitimate delivery rather than silently expand scope.
Delivery uses `providerAcceptedAt`, set only from the actual positive integer
`acceptedAt` in the authenticated CP intake receipt. The older display/context
`createdAt` fallback is retained but is never used for eligibility. Old indexes
without this separate receipt-proven field cannot freshen themselves into scope.

Missing/conflicting manifests and unmarked existing owner records fail closed.
No manifest replacement, migration, unquarantine, reset or deletion endpoint is
exposed. Restarts verify the identical canonical manifest without reimporting.

After reviewed code/bindings deployment **with delivery paused**, call the
read-only `GET /operator/delivery-cutover` with the dedicated
`TG_SANDBOX_CUTOVER_READ_TOKEN` bearer. It returns cutover ID, canonical SHA256
digest, quarantine counts and pause state; it sends nothing. This credential is
separate from the Telegram webhook secret and has no task or delivery mutation
route. Check the manifest proof and `/deliveries/:taskId` quarantine
projections before restoring the signed webhook or allowing any drain. This
route is limited to the existing-UX sandbox Worker. DO endpoints are reachable
only through the sandbox's namespace binding; no public DO forwarding route
exists.

The protected-main GitHub Action `Read sandbox delivery cutover state` performs
this bounded read using the dedicated GitHub secret `TG_SANDBOX_CUTOVER_READ_TOKEN`
and prints only the cutover ID/digest, quarantine counts, pause state, and
`providerCalled: false`. It never invokes `/cron`, sends a Telegram request, or
accepts a task. Run it before any live sandbox ingress to confirm the deployed
manifest and pause state.

The probability sandbox remains fail-closed until the exact historical task and
delivery inventory is reviewed: `TG_SLICE_DELIVERY_PAUSED = "true"` and
`crons = []` in `wrangler.sandbox-tg-existing-ux.toml`. The pause flag exists
only in sandbox `[vars]`; do not provision a secret with the same name. The
manifest is a separate secret binding, never a checked-in variable.
`TG_DELIVERY_OWNER` is a namespace binding, not a variable or secret. Parent
alone owns explicit activation after review/inventory.

### Immutable empty-marker recovery (2026-10-10)

The deployed V1 owner reported a valid but empty cutover inventory (`0` tasks,
`0` deliveries) even though read-only source inventory found 53 canonical CP
tasks and four sent legacy KV delivery records. Keep V1 paused and untouched;
its manifest fingerprint cannot be replaced safely. The sandbox now also pauses
new webhook intake while reconciliation is reviewed. `TgDeliveryOwnerV2` uses
an independent SQLite Durable Object namespace and the separate secret
`TG_SLICE_DELIVERY_CUTOVER_MANIFEST_V2`. The protected-main
`Prepare isolated sandbox delivery cutover V2` workflow derives the V2 manifest
from the canonical CP task table, exact legacy KV delivery records, receipt
indexes, and the approved test-chat GitHub secret. It refuses an incomplete
receipt index, malformed record, cross-profile CP row, or inventory over the
manifest cap. It preserves each historical delivery's exact destination,
including older sandbox chats, as quarantined evidence; the test-chat match and
nonmatching counts are reported without exposing chat IDs. It writes only the
V2 Worker secret and does not deploy.
Deploy the reviewed main Worker only after that job reports the complete
inventory. Then run `Read sandbox delivery cutover state` and verify the V2
quarantine counts while both ingress and outgoing delivery remain paused. Do
not resume the sandbox until the historical duplicate-message evidence has
been reconciled against this inventory.

## Autonomous scheduled reconciliation

The sandbox's exported `scheduled` handler opens the existing durable owner,
validates the immutable manifest, drains queued deliveries first, then performs
bounded delivery discovery using authenticated CP typed `/status` projections.
It does not rebuild conversations or request journal pages. No new controller,
timer loop, model polling, or task recovery/start call is introduced. The schedule
does not change allowed chats, namespace, manifest, tombstones, or retry policy.
Delivery pause still prevents provider dispatch; missing/conflicting manifests
fail closed before reconciliation. Old/unknown records never become retryable.

One scheduled invocation claims at most one eligible delivery, with the existing
bounded provider request timeout and explicit-429 attempt cap. Thus pending
receipt and terminal deliveries may take separate ticks; overlapping scheduled
invocations still use transactional durable claims. If the first drain claimed
nothing, a final drain may send a newly discovered candidate, still at most one
provider attempt per invocation. The cadence is one minute, not a delivery SLA.
Discovery has a ten-second monotonic deadline and at most six steps per tick.
The cap assumes no paid Worker tier: each discovery step issues at most six
DO/KV/CP calls, plus owner open and at most two drain calls (39 total), with one
provider call conservatively included (40). Pagination steps issue only three
calls. No retry loop or journal pagination consumes an extra request budget.
Each step lists at most one conversation key or examines one turn. A durable
SQLite-owner cursor carries KV pagination, conversation key and turn offset
across restarts. Discovery lists only `conv:tg-`, matching the controller's actual
`tg-<chat>[-t<thread>]` conversation IDs, so `conv:u:*` ingress dedup hints never
consume discovery steps. Those hints are not deleted or changed. Persisted
cursors are prefix-versioned: an older broad-prefix cursor is reset to the
beginning with its revision fence retained before any old opaque token is used;
the next transactional advance persists the new prefix. This changes discovery
metadata only, never the manifest, delivery records, or conversation history.
Each conversation visit examines one turn, advances to the next
conversation, and durably retains its independent turn offset. Thus a large or
growing first conversation cannot monopolize later conversations. Transactional
revision compare-and-swap prevents stale ticks rewinding it; turn advancement
precedes CP I/O, so a stalled turn does not pin future ticks. Conversation pages
and each conversation's turn offsets wrap around independently. No user history is
truncated, rewritten, or reclassified by the discovery cursor.

Discovery waits are deadline-bounded; CP status requests also receive the shared
deadline abort signal. Queue drain is independent and precedes those waits.
Provider I/O retains its existing timeout and durable unknown handling; the
discovery deadline is not a whole-tick/provider timeout or delivery SLA.
An interrupted discovery step can be revisited on the next complete scan;
eventual KV discovery lag or persistent CP/provider outages still prevent a
guaranteed delivery deadline. Cursor metadata is internal transport state only,
not a new task controller or delivery authority. Manifest/pause/quarantine
validation remains in the same owner on every call.

Parent-only live acceptance: after isolation/review, deploy this sandbox config,
submit one reserved quick-answer task and one native task, then let genuine
scheduled events deliver their receipt/result without calling `/cron`, running
the mutating smoke harness, or polling Telegram's provider API to drive progress.
Correlate scheduled-event evidence with authoritative read-only DO summaries,
CP terminal/canonical Runner proof, and independent owner-observed Telegram IDs.
Repeat read-only snapshots after parent redeploy to prove retained IDs/attempts,
manifest digest and quarantines. Never count the offline handler fixture as a
live scheduled-trigger/provider acceptance proof. Keep historical failures.
For an operator stop, disable this sandbox trigger and/or set its existing plain
pause variable to `true`; do not delete owner state or replace the manifest.

## Verification

```sh
npx vitest run tests/p11*.test.js
npm run check
```

Tests include the original strong-memory-KV two-drain duplicate (two provider
calls, stored attempts=1), the durable claim replacement, cron/manual interleaving,
delayed acknowledgement storage, lost acknowledgement/restart, bounded 429,
stable provider IDs, mandatory manifest/conflicts and old-task quarantine.
`p11-delivery-owner-workerd.test.js` runs a real local SQLite DO in workerd with
mocked Telegram networking; it is not live Telegram/provider acceptance. Unit
storage/queue fixtures are test doubles, not a distributed locking implementation.
