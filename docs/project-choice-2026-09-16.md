# Project choice at dialog creation

## Required behavior

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

## Ownership

The gateway preserves the chosen project's identity and snapshot of the menu. Backend project decisions are checked by contract; failures stay explicit. Implementation/evidence live in the task issue, not in a production-readiness claim in this document.
