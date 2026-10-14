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
