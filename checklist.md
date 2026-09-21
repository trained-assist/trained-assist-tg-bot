# Checklist — feat: graceful large-file handling (issue #156)

## Implementation

- [x] `src/intake-preflight.js` — early size check in `media` branch (video/audio): if `!msg.voice && file_size > 20 MB`, send friendly message and return `{ fileTooLarge: true }`
- [x] `src/intake-preflight.js` — early size check in `file` branch (document/photo): same guard before `storeTelegramFile`
- [x] `src/handlers/message.js` — after `prepareIntake`, check `msg.fileTooLarge` and return early; filter `fileTooLarge` items from `intakeItems` batches
- [x] `tests/intake-media-content.test.js` — updated oversized-media tests: assert `sendMessage` with friendly text + `runTask` not called; added voice exclusion test

## Tests

- [x] All 333 tests pass (`npm test`)

## Deploy checklist

- [ ] PR merged to main → auto-deploy via GitHub Actions → Cloudflare Worker
- [ ] Smoke: send a 30MB video to the bot → expect friendly message, no "Внутренняя ошибка"
- [ ] Smoke: send a 5MB voice → expect normal transcription (not blocked)
