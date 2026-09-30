# Batch input and snapshots (2026-09-25)
- [x] Inspect intake DO, preflight, assembly, outbox, runner controls and session UI.
- [x] Implement quiet-window collector and shared draft/launch assembly.
- [x] Persist actual request snapshots and add authorized inspection callbacks.
- [x] Wire running/completed controls and journal (companion agent branch).
- [x] Replace superseded receipt tests; 569 tests + 286 mandatory scenarios + workerd/R2 runtime passed.
- [ ] Green CI and staging on PR revisions, merge, deploy and verify live SHA.

# Ф1 — кнопочная гигиена: superseded-пикер теряет кнопки сразу (2026-09-30)
Goal: https://github.com/trained-assist/trained-assist-tg-bot/pull/317 — фаза Ф1 плана trained-assist/trained-agent-architecture (US-BUG-01)

- [ ] CI green on https://github.com/trained-assist/trained-assist-tg-bot/pull/317
- [ ] Merged to main
- [ ] Deployed to prod — verified live (повторное открытие пикера не оставляет живых кнопок у старого)

# Ф3-part — явный выбор «В очередь» в busy (2026-09-30)
Goal: https://github.com/trained-assist/trained-assist-tg-bot/pull/318 — часть Ф3 плана architecture (RC-01/02/06, part of #316)

- [ ] CI green on https://github.com/trained-assist/trained-assist-tg-bot/pull/318
- [ ] Merged to main
- [ ] Deployed to prod — verified live (busy-квитанция: «▶️ В очередь после текущей» + честный текст)

# Ф4-B1 — busy-окно = set requestId (2026-09-30)
Goal: https://github.com/trained-assist/trained-assist-tg-bot/pull/321 — подготовка «⚡ Параллельно» (RC-03, part of #316; #320 закрыт — ветка была переиспользована)

- [ ] CI green on https://github.com/trained-assist/trained-assist-tg-bot/pull/321
- [ ] Merged to main
- [ ] Deployed to prod — verified live (поведение нейтрально, hold на месте)
