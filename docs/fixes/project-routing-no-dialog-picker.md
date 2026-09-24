# Ambiguous input selects a project

Owner requirement (2026-09-24): automatic dialog selection must not appear.
The prior copy-only change left both the full dialog picker and the stale-session
confirmation reachable on classifier low/error/medium results.

The gateway now resolves ambiguous input through the durable project-choice flow.
Captured text, media references, subsequent batches and deep mode survive selection.
An existing pending project choice bypasses classification. A validated high-confidence
match can continue within the current project; explicit selections and recent-session
continuation remain supported. List/classifier errors cannot guess the last session.
Single-project decisions bind and persist the actual project returned by the server.
Legacy sp: callbacks remain readable for already-issued menus; no new automatic sp:
menus are emitted by message handling.

## Replaced obsolete tests

`tests/session-disambiguation.test.js`: removed “shows session picker for plain text
with old session and multiple sessions”, “shows 2-button confirm (not full picker)
when classify returns medium”, and “stores pending message when showing stale confirm”.
They asserted behavior explicitly rejected by the owner. Replacement executable tests
cover low/medium/error/null/unknown session ID/list failure -> project flow; valid high
confidence, project boundaries, single-project binding and command/recent continuation.
`tests/project-choice-flow.test.js` exercises real handlers + KV + project callback for
low/medium/error with a document, additional text, one dispatch and selected project.
Both suites are mandatory in scripts/staging/suites.json.

## Risk and rollback

Ambiguous stale input creates a fresh internal session after project resolution;
implicit context from a guessed old dialog is intentionally not carried forward.
Explicit continuation still preserves context. No new service, migration, dependency
or background cost. Revert this PR and redeploy to roll back.

## Validation

Full unit suite: 428 passed. Mandatory scenario replay: 218 passed.
Syntax/command registry, staging Worker build and real workerd/R2 media runtime passed.
Cloud CI, isolated staging deploy and SHA-verified smoke must pass before merge.
