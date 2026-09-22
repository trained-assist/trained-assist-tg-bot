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
- [ ] Владелец просмотрел черновик Stories, подтвердил/поправил приоритеты Phase 1 ниже

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

## PR — fix(intake): photo/document receipt ack no longer says "voice"

Goal: closes US-MEDIA-02 / US-BUG-06 from Phase 1 above. `_ingestMedia`
(`src/intake-buffer.js`) hardcoded the very first receipt ack to "🎙 Принял
голосовое, расшифровываю…" for every media type — including photos and
documents. Owner reported it twice (once in the KNOWN-BUGS write-up, once
again with a screenshot on 2026-09-22). Fixed by branching on the existing
`needsTranscript(msg)` helper (already used by `MediaJob` to decide
transcribe-vs-skip): voice/audio/video keep the transcribing text,
photo/document now get "📎 Принял вложение, сохраняю…".

- [x] Fix `src/intake-buffer.js` receipt text
- [x] Regression test in `tests/media-jobs.test.js` (photo receipt ≠ voice wording; voice receipt unchanged)
- [x] Full suite green (`npm test` — 378/378)
- [ ] PR opened, CI green, merged
- [ ] Deployed to prod, verified live
- [ ] Mark US-MEDIA-02/US-BUG-06 as ✅ in Phase 1 list above and in `docs/user-stories/KNOWN-BUGS-2026-09-22.md`

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
