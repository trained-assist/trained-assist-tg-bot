# Intake automatic launch contract — 2026-09-24

The owner replaced optimistic immediate launch with explicit authorization or three quiet minutes. All ordinary text, including short messages, follows the same timer. Each new message or completed media preparation resets it. Clear and likely requests launch once that timer expires; insufficient or failed checks hold input and show a manual launch option. An uncaptioned file supplies context, not an instruction. A buffer snapshot is compared again under the launch lock so an old LLM result cannot consume new input. Timers written by the old policy get a fresh three-minute period after upgrade.

Standalone execution commands (продолжай, делай, запускай, всё готово) and the launch button remain immediate. Acknowledgments (ок, понял, ага) and '?' no longer count as authorization; this explicitly supersedes the owner's September 22 '?' shortcut. Commands containing additional prose use the normal timer.

Cost/tradeoff: ordinary requests wait three minutes; no extra model calls per batch. Errors hold rather than execute. Telegram provides new messages, not live typing contents, so silence is measured from received input/preparation completion.

Replaced obsolete tests in tests/intake-buffer.test.js (likely extra grace period) and tests/intake-routing.test.js (acknowledgments/'?' launch): executable replacements verify the shared 180-second period and explicit commands. Added short /ingest, old verdict/new input, MD-file, invalid verdict, and gate transport-failure regressions; these run in staging as well.

Pair with agent fix/intake-actionable-gate for conservative classification and server-side errors. Revert commits and redeploy for rollback.
