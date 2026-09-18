# Staging propagation smoke

Gateway #135 cloud deploy succeeded, but smoke run 35184218943 saw 500, 404,
then 200; a separate body-fetch immediately returned 404. The old check validated
status and revision on different responses during Workers propagation.

check-health.mjs validates HTTP success and the exact BUILD_SHA on the same
response, with bounded retries (12 attempts, five-second request timeout/delay).
Wrong/missing revisions, HTTP failures, invalid JSON and network failure still
block the gate if no verified response arrives. No skips or continue-on-error.

In tests/release-gates.test.js, the assertion in "production requires actual
staging, smoke and scenarios; health verifies deployed revision" previously
required an inline Python string. Replaced only that implementation-specific
assertion with the helper invocation plus exact SHA argument. The release
requirement has not changed: successful actual staging at this commit is mandatory.
Its executable behavior is now covered by three tests in
 tests/staging-health.test.js (also included in mandatory scenario-gate).
