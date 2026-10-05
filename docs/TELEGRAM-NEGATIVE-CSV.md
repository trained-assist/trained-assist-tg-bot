# Controlled negative Telegram CSV operator

Source-only follow-up to [architecture #140](https://github.com/trained-assist/trained-agent-architecture/issues/140).
This is not a router or a deployment. No live acceptance is claimed by offline
tests. The parent must first approve isolation, reviewed DO delivery ownership
and autonomous terminal delivery. Do not run during the Telegram delivery pause.

The separate `scripts/integration/telegram-negative-csv.mjs` operator sends one
authorized synthetic Telegram update asking the engine to download/read the
immutable CSV and intentionally omit `outputs/category-results.csv`. It does
not use the generic success smoke, which expects CP `done`. It never calls
`/cron`, replays ingress, reroutes CP, sends directly to Telegram, accesses
Google, changes configuration, or restarts Runner. The pinned download is the
only external read allowed by the model goal; no external-user artifact is
requested. The engine can acknowledge intentional omission in its answer.

## Preconditions and private bindings

- Parent explicitly approves one new negative case after DO review/deployment.
- Use a fresh, idle owner-approved sandbox conversation, no awaiting-input
  continuation, and the actual mapped CP profile. Reserve explicit update and
  message IDs against genuine Telegram traffic; never reuse an older case.
- CP policy declares exactly `outputs/category-results.csv` as the host output
  for this agent run. Do not alter policy/model/engine bindings in this operator.
- Use the authenticated bindings from `INTEGRATION-V1-SMOKE.md`, including
  pinned `SMOKE_UPDATE_ID`, `SMOKE_MESSAGE_ID`, `SMOKE_MESSAGE_DATE` and approved
  chat/user IDs. Both endpoints must be HTTPS. Keep files mode 0600 outside Git.
- Add absolute `INTEGRATION_UPDATE_FILE`, `NEGATIVE_CHECKPOINT_FILE` and
  `NEGATIVE_ADMISSION_FILE` paths to this case's own private bindings. Do not
  reuse a previous checkpoint/evidence path. Set `NEGATIVE_CUTOVER_ID` to the
  reviewed active DO cutover and `NEGATIVE_AUTODELIVERY_APPROVED` to `yes` only
  when the parent authorizes the live submission. The cutover endpoint must
  report `ready:true`, matching ID and `paused:false`.

Request timeout defaults to 60 seconds, capped by the remaining overall budget;
overall budget defaults to 120 seconds, maximum 900 seconds. Body reads are
capped at 256 KiB and release/cancel readers. There are no HTTP mutation retries.

## Offline prepare, then one authorized submission

Create a dedicated private bindings copy first. Reserve IDs/date yourself;
neither this operator nor the preparation below invents IDs. Pin the exact goal
and save update bytes offline, without printing credentials or payload:

```sh
INTEGRATION_BINDINGS_FILE=/absolute/private/negative-bindings.json node --input-type=module <<'JS'
import { readFile, writeFile } from 'node:fs/promises';
import { readLiveConfig, serializeUpdate } from './scripts/integration/telegram-v1-smoke.mjs';
import { NEGATIVE_TEXT } from './scripts/integration/telegram-negative-csv.mjs';
const file = process.env.INTEGRATION_BINDINGS_FILE;
const bindings = JSON.parse(await readFile(file, 'utf8'));
bindings.SMOKE_TEXT = NEGATIVE_TEXT;
const body = serializeUpdate(readLiveConfig(bindings));
await writeFile(bindings.INTEGRATION_UPDATE_FILE, body, { flag: 'wx', mode: 0o600 });
await writeFile(file, JSON.stringify(bindings), { mode: 0o600 });
JS
```

`--prepare` performs no HTTP. It creates/fsyncs an exclusive mode-0600 checkpoint
and its directory, pinning body/scope hashes and the expected CP task ID derived
from the actual profile + NUL + Telegram request identity. Existing checkpoints
are refused, not reset:

```sh
INTEGRATION_BINDINGS_FILE=/absolute/private/negative-bindings.json \
  node scripts/integration/telegram-negative-csv.mjs --prepare
```

Only after the parent clears live execution:

```sh
INTEGRATION_BINDINGS_FILE=/absolute/private/negative-bindings.json \
  node scripts/integration/telegram-negative-csv.mjs --submit-approved
```

Health/cutover are checked first. Before the sole `/webhook` POST, the checkpoint
is fsynced as `submission_unknown`. The acknowledgement must identify the
expected fresh task with `duplicate:false`; otherwise stop. A timeout, crash,
wrong response or lost acknowledgement never authorizes another submission.
Concurrent operators are rejected by an exclusive lock. A surviving lock after
a process crash requires explicit operator reconciliation, not automatic removal.

## Read-only verification and admission witness

Parent obtains a fresh **complete** read-only snapshot of the own Runner's
JSONL admission journal after the task is terminal and saves it mode 0600 at
`NEGATIVE_ADMISSION_FILE`. Never print or publish raw journal entries: they may
contain prompts/environment/credential metadata. This script does not SSH or
fetch Runner journals. A truncated, stale or synthetic snapshot cannot attest
live uniqueness; retain capture time/revision/hash and full-file provenance
privately. A complete snapshot is bounded to 8 MiB.

```sh
INTEGRATION_BINDINGS_FILE=/absolute/private/negative-bindings.json \
  node scripts/integration/telegram-negative-csv.mjs --observe
```

Observation uses only signed CP `/status` (a read-only POST) and authenticated
gateway `/deliveries/:taskId` reads. It can reconcile the same original
`submission_unknown` checkpoint without another ingress POST. Auto-delivery
must finish on its own; the operator never drives `/cron` or delivery retries.
If the journal snapshot is not ready, observation stops incomplete: supply the
fresh snapshot and resume `--observe`, never `--submit-approved`.

PASS requires all of:

- CP task `failed`, stage `finished`, generation 1, exact `ARTIFACTS_MISSING`
  result failure code, zero artifacts.
- Exactly one failed CP orchestration attempt, generation 1,
  `error_class=ARTIFACTS_MISSING`, attached canonical Runner run ID.
- Matching DO terminal `terminal:<taskId>:g1`, `sent`, one attempt, positive
  real Bot API provider message ID, exact owner destination/thread, not a
  quarantined/imported legacy record.
- Complete journal contains one matching admission and one dispatch for that
  canonical run, owner generation/profile match, and the declared CSV output.
- A second read-only status/delivery read preserves that proof. The original
  first proof is retained if later readback changes; it is never overwritten.

`done`, another failure class, generation changes, duplicate attempts/admissions,
extra artifacts, provider-ID drift, delivery `unknown`/`sending`/quarantine/dead,
wrong destination, or absent evidence is blocked/incomplete, not a negative PASS.
Missing records do not prove nonacceptance. No new IDs, tasks, nonce or reruns
may supersede an unknown outcome. Keep original timeout/failure checkpoints.

Output contains only task/run/attempt/provider IDs, expected error class and
counts; no addresses, tokens, sender/chat identity, model logs or answer text.
Exit 0 means the selected step completed; only `outcome:pass` is final acceptance.
Exit 2 means blocked/incomplete; it is not permission to retry submission.
Bot API acceptance does not prove human reading. Injection is not genuine human
Telegram ingress. Engine exit 0 and native GHA source/tool-read provenance need
separate private witnesses; CP failure alone cannot establish engine exit code.
Journal one-dispatch proof is not a universal exactly-once model/provider claim.

## Offline checks

```sh
node --check scripts/integration/telegram-negative-csv.mjs
./node_modules/.bin/vitest run tests/telegram-negative-csv.test.js
```

Fixtures cover preparation before dispatch, unchanged saved bytes, one POST,
lost acknowledgement reconciliation without retry, expected terminal failure,
one admission/dispatch/send, false-success refusals, cutover pause, oversized
body cleanup, missing journal and provider readback drift. They make no real
Telegram, Runner, Google or CP calls.
