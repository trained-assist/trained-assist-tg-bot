# Isolated branch staging

The shared staging Worker had migration tag v4-media from an unrelated feature;
deploying the restart branch tried to recreate IntakeBuffer and failed with
Cloudflare 10074. Never delete/rewrite that Worker's data or migration history.

CI now deploys the exact tested source to ta-tg-staging-<12-char SHA256(branch)>.
The mandatory gate still requires scenarios, actual deployment and exact-revision
HTTP smoke. PREVIEW_ONLY blocks every non-health request and scheduled invocation;
staging crons are empty. No Telegram credentials, webhook, user messages or LLM
calls are provisioned. This cloud smoke verifies packaging/deployment; functional
routing/recovery scenarios continue running against isolated fixtures.

Cost/lifecycle: one Worker and private Durable Object namespaces per branch;
existing dedicated staging KV is bound but inaccessible in preview mode. No
periodic traffic. The owning release must delete its preview after closure using
wrangler delete --env staging --name <computed name> (after checking the exact
branch/name), retaining required CI evidence first. Main's preview remains for
subsequent releases. Existing shared staging and its MediaJob data stay untouched.
