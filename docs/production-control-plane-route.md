# Production Telegram Control Plane route

The main production Worker now uses `EXECUTION_BACKEND=control-plane` in its
normal `src/index.js` runtime. It keeps the existing production Worker name,
Telegram webhook URL, bot token, webhook secret, user registry, sessions,
legacy media bindings, and existing command handlers. The deployment does not
replace the bot entrypoint with the sandbox Worker.

The initial production route is pinned to the owner's private Telegram account
and the dedicated `production-e2e-telegram-v1` Control Plane profile. Other
chats cannot submit tasks through this route until production has a verified
per-user profile and workspace mapping. This pin prevents one shared test
profile from receiving another user's task or history.

Control Plane ingress and delivery use a new `ProductionE2eIntakeBuffer`
namespace and a new `ProductionE2eTgDeliveryOwner` namespace. They do not reuse
the existing production intake or retry namespaces. The migration `v5-production-e2e`
only creates these two classes; it does not delete or migrate existing state.
Conversation indexes use `conv:` keys in the existing `USERS` KV namespace;
user records stay under `user:` keys. Production login sessions use a separate
session namespace prefix.

The scoped signature is stored as the GitHub Actions secret
`CONTROL_PLANE_PRODUCTION_E2E_SIGNATURE` and synced to the main Worker during
the protected-main deployment. Health reports backend and pause state without
secrets. Production smoke requires Control Plane routing, ingress and delivery
enabled, and stop enabled. Telegram identity, webhook target, deployed SHA,
and unsigned-webhook rejection remain part of the same smoke.

The Cloudflare production CP endpoint is called over HTTPS. The Telegram
gateway does not select a Runner or execution region; France-default placement
remains owned by Runner API. The test profile exercises the production CP
service and its deployed Runner route.
