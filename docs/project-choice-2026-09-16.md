# Project choice at dialog creation

## Verified production failure

`GET /project-decision?username=trained-assist-product-owner` returned HTTP 200,
`{action:"create", choices:[], note:"projects model unavailable"}` while `/projects`
returned nine real projects. The decision handler required `./sessions`, which does
not exist; the actual module is `./session-store`. Its catch disguised the exception
as an empty profile. The gateway also intentionally skipped its delayed picker for
attachments, and neither `/new_dialog` nor `nd:` showed a picker at creation time.

## Gateway change

- `/new_dialog`, `nd:`, `nd:clean`, and creating a dialog with carried context now
  show project choice immediately, even with zero or one existing project.
- Six projects per page, all pages accessible, plus New project. Callback indices
  refer to a saved snapshot, never a re-fetched recency order.
- Automatic new-dialog selection runs before media download. Saved Telegram
  references preserve all batch items, cached attachments, voice transcripts and
  deep mode. Further batches waiting for choice are retained. Preparation failures
  retain the batch and permit retry.
- Project selection pins the new session and incoming batch; continuation retains
  its existing project. Replaced, expired and consumed menus cannot change it.
- If enriched decisions fail or report `note`, read the same agent's basic project
  list. Failure of both endpoints is explicit, not an invented empty project list.
- Existing legacy `pp:` menus remain compatible until their ten-minute expiry.

## Validation

221 gateway tests passed, including 19 additional cases across real handlers,
client fallback and route pinning. Worker build dry-run and command registry pass.
A direct call through the new client to the live server returns `action:ask` and
all nine projects, despite the old server's broken enriched endpoint.

Separate agent change imports session-store, extracts the handler for real-module
regression tests, and returns 503 for actual decision failures. All 575 Vitest tests
plus the CJS suites pass. It can ship in a later safe agent restart; the gateway
fallback restores this user flow without restarting the agent now.

## Operations and boundaries

No schema migration, data deletion, or agent restart. Rollback: revert gateway
commit and redeploy. Cost: one additional KV read per buffered message to pin an
explicit selection; a second HTTP read when decision enrichment is unavailable.
Gateway adds no model calls. Agent patch retains pre-existing optional summary
generation behavior, which can call the model for stale summaries when deployed.
UI behavior validated by handler tests with mocked Telegram, not a real-user chat
conversation. Production deployment/verification recorded separately after release.

Pending restart gateway PR #103 changes nearby code and must incorporate this
merge on its next update; do not overwrite this release with its older base.
