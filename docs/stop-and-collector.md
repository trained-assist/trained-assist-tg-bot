# Stop/skip and launch-button delivery

Stop targets username + chatId + sessionId on each configured agent, never username alone. Intake is fenced before cancellation. Explicit launch resumes held work; an epoch and intake generation reject late requests. Fresh archives pending input and preserves the new session binding even when an earlier dispatch finishes late. Skip cancels the current task and flushes accumulated new information. Command registration adds stop/skip/fresh to private/group menus (default and Russian), preserves existing domain commands, and is disabled in staging.

Collector delivery now installs the replacement keyboard before retiring its predecessor. A failed Telegram response leaves the previous keyboard live, shows the text launch command, and arms a durable retry. Overlapping voice/text completions serialize keyboard replacement.

Tests: stop-control.test.js exercises real commands and the real DO with HTTP boundary mocks, two chats under one profile, empty-buffer resume, skip, fresh, stale callbacks, two agent URLs and menu registration. intake-buffer.test.js covers Telegram failure, durable repair and overlapping collectors. Existing suites remain enabled.

Changed test contract: intake-buffer.test.js / "falls back to a plain-text ack when the keyboard send is rejected (#595)" previously stored the buttonless message as collectorMsgId. That assertion is obsolete because collectorMsgId must designate a usable launch control. Replaced with assertions for no false keyboard pointer and a durable retry, plus executable predecessor-preservation and repair tests. Intake-conversation assertions now include the generation token; no test was removed or skipped.

Release requires the companion agent protocol deployed on both configured VMs first. Unsupported agents fail closed with HTTP 404 on /tasks/control. All required checks, including staging deployment/smoke, must succeed on the current PR head before merge. Local regression tests do not substitute for a failed staging deployment.

Costs: durable storage for paused input and retries; menu synchronization uses Telegram calls once per bot/version. No extra LLM calls. Revert together with the agent PR; archive files stay intact.
