# Temporary Telegram UI lifecycle

Problem: project/session choices checked a 10-minute pending-task timeout only
when clicked. No timer retired their Telegram messages; navigation menus stayed
indefinitely. Existing callback tests checked routing, not lifecycle or cron.

Disposable gateway menus now register their Telegram message IDs in SESSIONS
under a bot-ID namespace. The existing minute cron removes project/session
pickers at 10 minutes and session/archive/file-navigation menus at 15 minutes.
API failures retain records for retry; deletion restrictions fall back to removing
markup. This preserves useful answers, intake data, profile screens and durable
plan/quick-answer buttons. Successful conversion of a picker to a status message
cancels deletion. Personal and group chats share the same helpers and policy.

Callbacks independently reject expired menus before executing actions. A stored
picker message ID prevents an earlier picker from selecting a newer pending task.
Existing pre-release menus cannot be enumerated through Telegram Bot API: they
are retired when clicked; automatic expiry applies to newly registered menus.
The queue is persistent, capped at 48 hours for abandoned retry records; cron and
KV propagation can add latency beyond the deadline. No claim of exact-second
physical deletion. A callback is blocked immediately by its timestamp.

Operational cost: one additional KV list per minute while cron is active, plus
one queue write per menu, reads for queued menus and a delete on completion.
No LLM calls or agent restart. Revert the change and redeploy for rollback;
remaining queue records expire automatically. No user content is removed.

Validation: 201 tests PASS, syntax/command registry PASS, worker dry build PASS.
New tests cover both chat types, actual scheduled() and callback entrypoints,
10/15-minute boundaries, cancelled cleanup, failed sends/edits, deletion fallback,
429/network retries, KV pagination, bot isolation and superseded pickers.

This branch also integrates the existing quick-preflight change (#97) with main's
reply/group intake fixes (#98/#99), preserving cached attachments, preparation
barriers and original-session routing. This avoids undoing already deployed work.
