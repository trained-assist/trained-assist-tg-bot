## PR — fix(intake): atomic claim for the /ingest collector, kills a duplicate-bubble DO race

Goal: owner treated a recurring "Не удалось подготовить вложение" report (chat
8815112204, @super_recruiter_assistant_bot) as a symptom of a broader class —
"state on CloudFlare regularly acts up" — and asked to reproduce the failure
directly against the live worker (not guess), fix with a direct point-deploy
first, verify, then go through the normal PR flow. Investigation, in order:

1. `GET /debug/intake/8815112204` on the live recruiter worker → completely
   empty state (`retryBatch: []`, `busy: false`). PR #210 (already deployed)
   already closed the "stuck forever" failure mode this chat had hit.
2. Added a temp `/debug/transcribe-test` route (point-deployed to `recruiter`
   only, no PR, per the owner's explicit ask), fed it the user's own just-sent
   voice note — Deepgram + DEEPGRAM_API_KEY on that env both work fine. Ruled
   out the specific external dependency that failed before 2026-09-22.
3. Read `src/intake-buffer.js`'s `/ingest` handler end-to-end looking for the
   *class* of bug, not another one-off: found `remaining = get('buf')` /
   `get('busy')` read OUTSIDE `_exclusive()`, right after a lock-protected
   write — exactly the class the checklist's own Phase-1 backlog already
   flagged as 🔴 US-BUG-03 ("гонка в IntakeBuffer DO"), never actually
   investigated until now.
4. Wrote a red test first (`tests/intake-buffer.test.js`, "two ingests whose
   preflight overlaps…"): two attachments whose `preflight()` (transcription)
   overlaps — a realistic "two voice notes within a second" burst — each
   compute their own stale `buf` snapshot and independently call
   `_armAutoDispatch`. Failing before the fix: 2 collector bubbles sent, the
   first reporting a stale count. Confirmed red, then fixed.

Fix: the write (`buf`/`received`) and the decision snapshot (`items`, `busy`)
now happen atomically inside the same `_exclusive()` block, tagged with a
monotonic `armSeq` claim token. The actual Telegram send still happens
outside the lock (file-level invariant: I/O must never hold it), but only
the call that is *still* the freshest committed write (re-checked via a
second, I/O-free `_exclusive` read of `armSeq` right before sending) actually
sends — an earlier, now-superseded call silently defers to the fresher one.
17/17 `intake-buffer.test.js` tests pass, 394/394 full suite passes.

Point-deployed directly to `recruiter` then default env to verify live
before this PR (owner's explicit request — fix, verify, then PR/merge):
```
export CLOUDFLARE_ACCOUNT_ID=d740a05e9442c1d0feacae2dfc673e93
npx wrangler deploy --env recruiter   # verified: /health + /debug/intake/8815112204 both clean post-deploy
npx wrangler deploy                   # default env, same bug class
```
The temp `/debug/transcribe-test` route from step 2 is kept (mirrors the
existing `/debug/intake/:chatId` pattern) — useful for the next "attachment
prep failed" report to isolate Deepgram from Telegram without needing a
fresh `file_id`.

Scope note: this closes ONE concrete instance of US-BUG-03 (the `/ingest`
tail). `_armAutoDispatch`'s OTHER unprotected caller (`/append`, line ~202)
and `_ingestMedia`/`_mediaResult`'s busy-checks share the same shape and were
NOT touched here — flagged, not fixed, to keep this PR reviewable as one
diff. Phase-1 backlog item for those: same pattern, same fix.

- [ ] CI green
- [ ] Merged to main
- [ ] Already deployed+verified live (see above) — re-verify after merge that
      the merge commit's deploy didn't drift from what was tested

---

## PR #206 — fix(intake): delete the collector bubble once the task has launched

Goal: «▶️ Запустил проработку» was an edited husk left in the chat forever —
pure procedural noise once the real placeholder/agent response takes over.
Delete the collector message outright at dispatch instead; fall back to the
old neutral edit only if the placeholder send itself failed (collector id
still needed as the streaming target then). Owner request 2026-09-22
(screenshot of the stale bubble in-chat).

https://github.com/trained-assist/trained-assist-tg-bot/pull/206

- [ ] CI green on PR #206
- [ ] Merged to main
- [ ] Deployed and verified live — collector bubble disappears after ▶️ launch in a real chat

---

## PR #192 — fix(intake): project picker copy confirms task already captured

Смержено в main (`4f9667a`, 2026-09-22 21:02 UTC), CI зелёный (ci/smoke-test/
staging-gate/scenario-gate/deploy — все success), deploy отработал на этом же
коммите. Закрыто фактически, не только «лежит в коде».

- [x] CI зелёный
- [x] Смержено в main
- [x] Задеплоено и проверено вживую (deploy check-run success на merge-коммите)

---

# Checklist — User Stories раздел + план отказа от «диалога» в пользу «проекта»

Goal: закрыть накопившийся класс «мелкие баги диалогового слоя находятся
заново каждый раз» — сначала формальным разделом User Stories + тестами по
ним, потом (после явного Phase-1) переписать модель на «только проект» без
отдельного понятия «диалог», с MCP-инструментом project-context для
навигации по файлам/summary проекта. Порядок фаз обязателен — Phase 2/3 не
начинать, пока Phase 1 не закрыт (владелец явно попросил именно такую
последовательность, чтобы не мешать независимые UX-фиксы с архитектурным
рефакторингом).

Полный контекст: `docs/user-stories/README.md`,
`docs/user-stories/CURRENT-STATE.md`, `docs/user-stories/KNOWN-BUGS-2026-09-22.md`.

## Phase 0 — Current-state User Stories (этот PR)

- [x] `docs/user-stories/README.md` — формат Story + индекс раздела
- [x] `docs/user-stories/CURRENT-STATE.md` — Stories по сегодняшнему коду (накопитель, пикер проекта/сессии, медиа, топология чата), сверено с `git log` на 22.09
- [x] `docs/user-stories/KNOWN-BUGS-2026-09-22.md` — 6 новых Stories из свежей порции жалоб владельца (US-BUG-01..06)
- [x] Владелец просмотрел черновик Stories (голосовые, 22.09 вечер): подтвердил формат (один триггер → одна реакция, атомарно) — добавлена классификация по типу триггера в `docs/user-stories/README.md` (загрузка контекста / QuickAnswer-перехват / кнопка-команда / медиа / топология чата). Приоритеты Phase 1 ниже не менял.

## Phase 1 — Фиксы, НЕ связанные с диалог→проект рефакторингом

Каждый пункт = отдельный PR (свой checklist.md на время работы), в порядке
риска/цены из `KNOWN-BUGS-2026-09-22.md`. Не начинать Phase 2, пока здесь
не закрыто хотя бы 🔴/🟠 (US-BUG-03, US-BUG-01) — 🟡-пункты можно доделывать
параллельно с Phase 2, если дешёвые агенты простаивают.

- [ ] US-BUG-03 🔴 — разведка: гонка в `IntakeBuffer` DO при быстрой пачке ~10 сообщений (сериализация одного DO vs read-modify-write гонка) — red-first тест ПЕРЕД фиксом
- [ ] US-BUG-01 🟠 — снимать markup истёкшего/суперсиженного project/session-пикера тем же паттерном, что уже есть в `intake-buffer.js:325` для accumulator-кнопки
- [ ] US-BUG-05 🟡 — заметнее/быстрее ack на quick-команды (`/switch2klod` и т.п.), чтобы не провоцировать повторную отправку
- [ ] US-BUG-04 🟡 — **требует ответа владельца** (порог «сколько сообщений/сек считать пачкой», прежде чем схлопывать промежуточные ack — иначе прямой откат решения от 15.09)
- [ ] US-MEDIA-02 / US-BUG-06 🟡 — верификационный тест: фото ack не путает тип файла с голосовым; проверить видео (US-MEDIA-03) и документ (US-MEDIA-04) отдельными тестами
- [ ] US-BUG-02 🟡 — **требует ответа владельца** (архитектурный выбор: pinned-кнопка на чат вместо per-bubble — делать или оставить как есть)
- [ ] US-CHAT-04 🟠 (из `CURRENT-STATE.md`, матрица от 14.09) — подтвердить, всё ещё ли «бота добавили в группу» = тишина; если да — добавить приветствие/инструкцию `/login`
- [ ] US-MISC-01 🟠 — подтвердить, чинили ли «▶️ во время busy молчит»; если нет — явный ответ «уже иду по задаче»
- [ ] Каждый закрытый пункт выше: обновить Статус на ✅ в соответствующем файле `docs/user-stories/*.md` + добавить/починить тест в том же PR

## Phase 2 — Новые User Stories для модели «только проект» (без диалога)

Не начинать без Phase 1 🔴/🟠 закрытых. Содержание:

- [ ] Спроектировать MCP-инструмент project-context: что за папки в проекте, какие jsonl/истории сессий, краткое summary по каждому файлу — агент сам решает, инжектить в контекст или нет
- [ ] Написать `docs/user-stories/TARGET-STATE.md` — те же области (A-E из `CURRENT-STATE.md`), но БЕЗ понятия «сессия/диалог» как единицы выбора — юзер всегда в проекте, новое сообщение = навигация внутри проекта, не создание нового диалога
- [ ] Явно решить: что происходит с текущим «пикером проекта» (US-PROJ-02) в целевой модели — упраздняется или остаётся, но меняет смысл (не «какой диалог», а «какой проект»)
- [ ] Явно решить судьбу ВТОРОЙ, отдельной поверхности — `/sessions`/`/диалоги` (список диалогов для возобновления, `renderSessionList`/`sd:`/`ar:` callbacks) и полей `activeSessionId`/`lastSessionId` в tg-bot KV. Найдено разведкой 22.09: это отдельный UI-слой поверх уже конвергированной в `trained-assist-agent` модели «проект», не покрыт `PROJECTS-CONVERGENCE-PLAN.md`. Детали и файлы: issue #203
- [ ] Ревью TARGET-STATE.md с владельцем ДО начала миграции (Phase 3) — это архитектурная развилка с высокой ценой ошибки, тут разрешено и нужно спросить

## Phase 3 — Миграция

- [ ] Дифф CURRENT-STATE.md vs TARGET-STATE.md → список конкретных code-изменений (не с нуля — на основе готовых Phase 0/2 документов)
- [ ] План миграции существующих данных (сессии/диалоги существующих юзеров → проекты) — обратимость и риск для прод-данных обсудить с владельцем отдельно, это НЕ автоматический шаг
- [ ] Поэтапный рол-аут (по профилям/флагу), не одномоментная замена
- [ ] Тесты по каждой TARGET-STATE Story перед тем, как считать миграцию завершённой

---

## PR #194 — fix(intake): widen media-retry budget further

Goal: `retryMedia` (media-retry.js) now allows 4 attempts / ~9s delay cap
(~15.5s total headroom), up from #191's ~3.5s budget — journalctl showed
the agent VM restarting as close as ~60-90s apart during active dev,
tighter than #191's "isolated ~1-3s blip" assumption. A user retested #191
live in @super_recruiter_assistant_bot post-deploy and still hit
"Не удалось подготовить вложение". (Note: US-BUG-03 above — the IntakeBuffer
DO race — is a separate, likely-related suspect for the same symptom; not
addressed by this PR.)

https://github.com/trained-assist/trained-assist-tg-bot/pull/194

- [ ] CI green on PR #194
- [ ] Merged to main
- [ ] Deployed to prod (both `trained-assist-tg-bot` default env and `trained-assist-tg-bot-recruiter` env) — verified live

---

## PR #197 — docs(user-stories): trigger-type scenario taxonomy

Goal: closes the pending Phase 0 review item above. Owner feedback (voice,
22.09 evening) asked for atomic scenarios (one reference point to the next)
and named 3 scenario categories to classify by. Confirmed existing Stories
already match BDD's "one scenario, one behavior" rule; added a trigger-type
taxonomy to `docs/user-stories/README.md`; traced `getQuickAnswer`'s actual
call order to confirm no context-load race exists. Docs-only, no code.

https://github.com/trained-assist/trained-assist-tg-bot/pull/197

- [ ] CI green on PR #197
- [ ] Merged to main

---

## Архив: предыдущий checklist (issue #156, закрыт)

Оставлено для истории — реализация была помечена [x], смок-тесты деплоя не
были отмечены явно, но фича уже слита в `main` (commit `50a83f5`) и с тех
пор код по медиа-размеру не трогали повторно; считать закрытым.

- [x] `src/intake-preflight.js` — ранняя проверка размера в `media`-ветке (video/audio)
- [x] `src/intake-preflight.js` — ранняя проверка размера в `file`-ветке (document/photo)
- [x] `src/handlers/message.js` — обработка `msg.fileTooLarge`
- [x] `tests/intake-media-content.test.js` — тесты на превышение размера
- [x] Все тесты проходят (`npm test`)
