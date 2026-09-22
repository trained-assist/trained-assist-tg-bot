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
