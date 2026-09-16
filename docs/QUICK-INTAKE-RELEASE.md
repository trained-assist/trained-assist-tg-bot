# Voice quick-answer release incident, 2026-09-16

Production gateway version 60e60ab2-45c8-464b-822f-ade920c7ade9 (main 80053ac)
contained group/reply accumulation but no /ingest or /intake-quick code.
PR #97 remained unmerged and conflicted after #98/#99; its feature-branch tests
were not evidence of production activation. The running local agent already
served /intake-quick (authenticated empty payload → 400 invalid intake request).
No agent restart is required for this gateway release.

Tests had two blind spots: preflight tested a mocked successful agent response
without dispatch; deploy smoke accepted /health and fire-and-forget /webhook HTTP
200 without observing any completed behavior. Staging also lacked AGENT_URL,
AGENT_SECRET and DEEPGRAM_API_KEY, confirmed from binding names (no values read).

This release applies preflight to current main, preserving group admission and
reply continuation. Real dispatch → DO → media preparation → STT client → quick
client tests now exercise accepted/rejected matches in private/group reply/group
mention paths. External HTTP is mocked. On the old production files these tests
fail 6/8 cases; the repaired complete suite passes 196 tests.

/health/intake checks the actual configured primary/regional backend URLs and
credentials using deliberately invalid input, rejected before any user, LLM,
session or Telegram side effect. It fails with 503 if configuration is missing,
intake is disabled, the backend lacks the route, or auth/network fails. Results
are cached for 60 seconds per isolate. Both release smoke jobs require this
contract; the fake /ping sends to a hardcoded Telegram user were removed.
The readiness probe certifies endpoint compatibility, not STT/LLM quality.

Quick HTTP failures are logged and preserve the original message for explicit
collection/launch. Existing STT and quick-intent calls retain their ordinary
provider costs; readiness makes only bounded validation requests, with no LLM.
Rollback: revert this gateway PR and redeploy. Stored batch format is compatible.

Staging is not a valid end-to-end environment until its missing backend/STT
configuration is provisioned. Do not copy production credentials into it merely
to turn the checks green. Its smoke must remain red while it is unconfigured.
