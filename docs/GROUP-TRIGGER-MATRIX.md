# Group message admission and shared intake

Owner decision, 2026-09-16: private and group chats use identical processing.
The group-specific rule only selects which messages are addressed to the bot.
This supersedes the earlier immediate-answer bypass for mentions and replies.

| Message | Condition | Route |
|---|---|---|
| Slash command | Any | Command handler |
| Mention in text/caption or reply to bot | Any group size | Shared routeText intake |
| Ambient text or media | allMsgMode on | Shared routeText intake |
| Ambient text or media | At most 2 members, including bot | Shared routeText intake |
| Ambient text or media, including reply to another human | More than 2 members, allMsgMode off/unset | Ignore |
| Ambient message, unknown member count | allMsgMode off/unset | Ignore |
| Service update | No actionable content | Ignore |

The administrative control group retains its dedicated command-only policy.
Admitted replies collect attachments and pin the current continuation using the
same code as private chats. Launch remains explicit. The intake kill switch and
missing-binding fallback are also shared. In large all_off groups each added
message must address the bot; an open collector does not admit other conversation.

Quick-answer-first activation remains separately pending in agent #636 and
gateway #97. This routing fix uses the common path where that feature will run.
No extra service, storage model, or API cost is introduced.

Tests: group-routing.test.js and intake-group-uniform.test.js cover admission,
reply session pinning, and private/small/all_on/addressed text/media parity.
