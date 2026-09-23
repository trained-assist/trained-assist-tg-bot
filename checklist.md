Goal: Intake media ack shows the real attachment type (photo/document) instead of always claiming "voice, transcribing"

- [ ] CI green on https://github.com/trained-assist/trained-assist-tg-bot/pull/215
- [ ] Merged to main
- [ ] Deployed to prod — verified live

Goal: ➕ Дополнить button for Telegram — supplement a running task with more context instead of only killing it (companion to trained-assist-web#33's Стоп/Дополнить, which shipped web-only)

- [x] CI green on https://github.com/trained-assist/trained-assist-tg-bot/pull/216
- [x] Merged to main (commit d774c23)
- [x] Deployed to prod — verified via deploy/smoke-test check-runs (success) on merge commit d774c23
- [x] Companion PR https://github.com/trained-assist/trained-assist-agent/pull/1185 (renders the button) also merged+deployed (verified via deploy-gcp/deploy-ru check-runs, success, commit 854ab2f)
- [x] Live Telegram verification — owner tested and the button never appeared despite waiting past the render threshold. Root cause was agent-side, not here: trained-assist-agent's stopButtonShown flag flipped before confirming the button-carrying Telegram edit actually landed, so a single 429/coalesce drop permanently hid the button with no retry (confirmed live via journalctl 429s on editMessageText during the owner's test session). Fixed in trained-assist-agent#1189/#1190 — this repo's `sup|` handler (callbacks.js) and pendingSupplement flow (message.js) were never the problem, no change needed here. See that repo's checklist.md for the "How to test ⛔/➕ buttons live in Telegram" procedure (this repo's `wrangler tail` only shows the *tap*, i.e. the callback_data round-trip — the button *rendering* is agent-side only and won't show up there).
