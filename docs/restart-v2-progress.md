# Restart v2 gateway preparation — trained-assist-agent#664

Draft, not the complete v2 release. Paired agent PR: trained-assist-agent#665.

This branch integrates the previously unmerged planned-restart gateway PR #113 into current main. Resolved conflicts by preserving current structured restart recipients (profile/chat/topic). Preserved durable RunOutbox deployment history and staging KV isolation.

Integration exposed two same-named staging jobs and a dependency cycle. The graph now requires independent CI and deterministic `scenario-gate`, followed by actual staging deployment, a smoke check of the exact deployed `BUILD_SHA`, and the final `staging-gate`. Production deploy follows that gate, including main pushes. PR checks require actual successful push checks on the PR head. No skip/continue-on-error exception. A graph regression test checks unique jobs, missing dependencies and cycles.

Run requests carry initiatedAt and threadId through client, durable outbox, retries and callback/command/message paths. Outbox failure notices preserve the forum topic. Agent#665 validates and stores these fields. Existing old agent ignores extra payload fields, while outbox still negotiates durable ingress before delivery.

Local validation: full unit suite; required deterministic replay; command registry/syntax; staging Worker dry build. GitHub CI plus actual staging deploy/smoke must be checked at current head before merging. Draft prevents auto-merge; branch push still runs isolated staging.

Outstanding: pre-launch/buffered activity reporting, waiting_confirmation callback and cancel controls with owner/idempotency checks, age-based policy and 40-minute deadline, paired end-to-end restart scenario and production smoke. Do not treat this PR as completed restart v2, and do not close #664. Staging /health verifies build revision, not the full restart lifecycle.
