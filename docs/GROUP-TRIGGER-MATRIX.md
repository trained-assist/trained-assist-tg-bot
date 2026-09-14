# Group message trigger matrix (когда бот реагирует в группе)

Owner requirement (2026-09-14, voice): «чётко разметить и проверить, на что бот
реагирует в группах». Three concrete demands + one old bug:

1. **2-member group (bot + 1 human)** → react to ALL messages, not only replies.
2. **@mention** → ALWAYS react (immediately, with an answer — not just "накапливаю").
3. **Large group, all-messages OFF** → react to nothing that isn't a command or
   addressed to the bot.
4. **Old bug:** large group, all-messages OFF → bot still reacted to **voice/audio**.

## Root cause (pre-fix)

The whole "react or not" decision lived inline in `dispatchInner` (index.js) with
**zero test coverage** — so it drifted. Two concrete defects:

- **Audio leak (#4):** the member-count gate was *skipped for voice/audio* when
  `allMsgMode` had never been set (`undefined`). Condition was
  `!allMsgMode && (!isVoiceOrAudio || allMsgMode === false)` → for undefined+voice
  this is `true && (false || false)` = `false` → gate skipped → bot answered voice
  in a 100-person group. Text obeyed the gate; voice didn't. Exactly the reported mess.
- **Mention buffered, not answered (#2):** an @mention passed the gate but then went
  through `routeText` → the intake accumulator, which only bypasses on
  `reply_to_message`. So a mention got «📥 Накапливаю ▶️» instead of an answer —
  felt like "mention doesn't react".

Empirical check: current QA group `-5496844108` is `type=group`, memberCount **2**
(you + bot). So the `>2` gate does NOT block it; plain messages there already reach
the accumulator and get the ▶️ collector. The "only replies react" feel in a
2-member group is the accumulator buffering ambient text — a deliberate #530
design (manual ▶️ launch), NOT a gate bug. See "Open fork" below.

## Corrected matrix (post-fix)

Decision extracted to pure, unit-tested `src/group-routing.js`. For a non-admin group:

| message | condition | disposition |
|---|---|---|
| `/command` | any | → handleCommand (mention stripped) |
| addressed = **mention (text OR caption, case-insensitive) OR reply-to-bot** | any group size | → **handleMessage directly** (bypass buffer → immediate answer) |
| ambient (not addressed, not command), no content | — | ignore |
| ambient | `allMsgMode` ON | → routeText (accumulate) |
| ambient | `memberCount <= 2` (bot + 1 human) | → routeText (accumulate) |
| ambient | `memberCount > 2`, all-msg not ON | **ignore — text AND voice/audio alike** (fixes #4) |

Key changes vs pre-fix:
- **No voice special-casing.** Audio obeys the same gate as text.
- **Addressed → immediate answer.** Mention now bypasses the accumulator like a reply.
- **Case-insensitive** mention + reply-to-bot matching; mention detected in **caption** too (photo/doc with `@bot` caption in a big group used to be ignored).

## Open fork (NOT changed here — needs an owner decision)

Requirement #1 taken literally ("2-member group → answer plain messages, not just
accumulate") conflicts with the deliberate #530 manual-launch accumulator, which
buffers ambient text in *both* private and 2-member-group chats and waits for ▶️.
The gate already lets those messages through; whether ambient plain text should
*bypass* the ▶️ buffer in a 1-on-1 is the standing intake-refactor fork
([[intake-swallows-conversation]]), not a trigger-gate bug. Flagged to owner.
