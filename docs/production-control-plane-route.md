# Production Telegram Control Plane route

The main production Worker now uses `EXECUTION_BACKEND=control-plane` in its
normal `src/index.js` runtime. It keeps the existing production Worker name,
Telegram webhook URL, bot token, webhook secret, user registry, sessions,
legacy media bindings, and existing command handlers. The deployment does not
replace the bot entrypoint with the sandbox Worker.

The ordinary production bot uses the `gateway` principal and
`trained-assist-production` profile. Production E2E tests use the existing
private test account (Telegram chat/user ID `1714048`) through this same
production Worker and profile. They do not deploy a sandbox bot against
production Control Plane and do not create a second production routing lane.
See `docs/TELEGRAM-USER-E2E.md` for the protected production test procedure.

Production health must report Control Plane routing configured, ingress and
delivery enabled, and stop enabled. E2E preflight additionally checks the
production bot identity, deployed build SHA, and that the test account's Intake
is idle before sending test messages.

The Cloudflare production CP endpoint is called over HTTPS. The Telegram
gateway does not select a Runner or execution region; France-default placement
remains owned by Runner API. The test profile exercises the production CP
service and its deployed Runner route.


## Agent input documents

The collector has no input preview button in the Control Plane lane. After a
Runner admission, Intake discovers the receipt-backed input through CP's
`GET /agent-inputs?taskId=...` and enqueues one `input-document` delivery per
Runner run ID and generation. Deterministic quick answers and tasks without a
confirmed Runner admission have no document. Existing input buttons never fall
back to a Telegram-only draft.

The JSON document contains the exact host input, additional instructions and
input-manifest pin saved with that admission. It describes input submitted for
execution, not the engine's internal system prompt or a reconstruction from
later conversation history. CP stores no deployment credential fields in it.

Publication keeps the original chat/topic and survives task completion and
Intake restarts. Downloads use the existing task-authorized artifact proxy and
SHA-256 checks. Telegram ambiguous sends retain the existing outbox unknown
state and are never automatically resent. Input documents are excluded from
output artifact lists. Historical admissions without a snapshot have no
reconstructed document.

Roll out the additive CP `/agent-inputs` and `cp-agent-input:` artifact support
before enabling the gateway change. Both use their protected-main staging and
production pipelines. A gateway rollback leaves queued document deliveries
intact; CP support must remain until those deliveries settle.
