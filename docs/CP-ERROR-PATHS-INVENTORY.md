# CP-ERROR-PATHS-INVENTORY — инвентарь обработки 404/5xx на CP-эндпоинтах

**Роль/задача:** worker, A8 (BACKLOG «Этап A»)
**Дата:** 2026-10-13
**SHA-якорь:** `2b5c195` — все L-номера сверены с `src/intake-buffer.js` и
смежными файлами на этот коммит; при дрейфе строк обновлять якоря в том же PR,
что двигает код.

## 0. Scope и метод

Инвентарь путей, по которым ошибки CP-эндпоинтов (`/intake`, `/route`,
`/start`) и остаточные пути `return false` в `_pollControlPlaneTasks` влияют
на барьер шлюза (busy-окно IntakeBuffer). Продолжает research §4 заметки
`state/research/2026-10-13-a1-barrier-404.md` (там — только `return false` в
poll'е) и закрывает пробелы контракта A3 (`docs/CONTROL-PLANE-BARRIER-CONTRACT.md`
§3: «hard cap в CP-ветке ❌», «5xx/timeout → ограниченные ретраи ❌»).

Метод: каждый call-site каждого эндпоинта × класс ошибки (404 / 5xx / timeout)
→ что происходит с барьером (`cpBusyRequests` + `busy`), информируется ли
пользователь, есть ли тест, есть ли issue. «Gap: none» = поведение корректно
**и** покрыто тестом.

Барьер поднимается только после durable receipt: POST `/cp-acceptance`
(`src/intake-buffer.js:895-901`) или `_recordControlPlaneAck`
(`src/intake-buffer.js:3113-3115`). Единственная точка снятия —
`_releaseBusyLocked` (`src/intake-buffer.js:2845-2863`).

## 1. Эндпоинты

### 1.1 `POST /intake` (C01, idempotent by requestId)

| Call-site | 404 | 5xx / timeout | Барьер | Пользователь | Тест / Issue |
|---|---|---|---|---|---|
| Основной путь: `src/lib/control-plane-execution.js:119` (catch L122-127 → rethrow) | throw → `message.js` catch → CP-ветка сразу rethrow (`src/handlers/message.js:318`) → ошибка в Telegram-хендлер | идентично | **не поднят** (receipt не persisted — пре-admission) | да, ошибка от Telegram-хендлера | **gap: none** — `tests/control-plane-execution.test.js` «leaves no durable receipt behind when CP /intake fails with 404/500» (receipts.size = 0, вызовов `/route` нет) |
| Batch lane: `src/sandbox-tg/worker.js:139` (без try/catch) | throw → `handleCallback` → Telegram-хендлер | идентично | batch lane не использует `cpBusyRequests`; но `batch.status='launched'` уже поставлен (L134), outbox-сообщение «запущена» — после start (L163) | **нет** — при throw пользователь не увидит ничего | ❌ **GAP-5** (#663) |

Замечание: snapshot (`https://intake/snapshot`, L77) и launch checkpoint остаются
после провала `/intake`; их подчищает `_recoverControlPlaneLaunch` на следующем
alarm-тике (см. GAP-3 про риск при исключении в самом recover).

### 1.2 `POST /route` (classify + continuation)

| Call-site | 404 | 5xx / timeout | Барьер | Пользователь | Тест / Issue |
|---|---|---|---|---|---|
| Intake-путь: `src/lib/control-plane-execution.js:162` (catch L168-173) | **глотается** → `routingPending=true` + лог `tg.cp.route_pending` | идентично | поднят (receipt уже persisted) | **нет** | ❌ **GAP-4** (#662); текущее поведение зафиксировано тестом `tests/control-plane-execution.test.js:98` |
| Poll-путь: `src/intake-buffer.js:3299` (невалидный ответ → L3301 `return false`) | throw → catch L3385 → `reconciliationFailure{stage:'route'}` → ретрай следующим тиком, **без ограничений** | идентично | поднят | **нет** | ❌ **GAP-4** (#662) + A2 (CP #280: ограниченные ретраи 5xx) |
| Web slice: `src/sandbox-tg/conversation.js:315` (`routeBeforeStart`) | throw (409 обрабатывается только для `/start`, L324) | идентично | web-slice вне барьера IntakeBuffer | ошибка в web-хендлер | 🔍 вне A8 (web lane) |

### 1.3 `POST /start` (explicit запуск; repeat = same instance)

| Call-site | 404 | 5xx / timeout | Барьер | Пользователь | Тест / Issue |
|---|---|---|---|---|---|
| Batch lane: `src/sandbox-tg/worker.js:145` (без try/catch) | throw → задача принята (`durable=true`), запуск не подтверждён; poll `/start` **не ретрайтит** (в `_pollControlPlaneTasks` нет вызова `/start` — только `/status` L3267 и `/route` L3299) | идентично | не применимо (batch lane) | **нет** | ❌ **GAP-5** (#663) |
| Web slice: `src/sandbox-tg/conversation.js:320` (`startOrKeepTerminal`) | 409 → skip (терминальная задача, L324-328); остальные → throw | throw | вне барьера IntakeBuffer | ошибка в web-хендлер | 🔍 вне A8 (web lane) |

## 2. Остаточные пути `return false` в `_pollControlPlaneTasks` (после A1-фикса)

Продолжение таблицы research §4. Классификация: **wedge** = ретрай никогда не
завершается (нет TTL, нет эскалации — см. GAP-1); **defer** = корректная
отсрочка следующим тиком; **guard** = конкурентность, корректно.

| Строка | Условие | Класс | Комментарий |
|---|---|---|---|
| 3247 | `_recoverControlPlaneLaunch()` бросает | ✅ fixed | catch больше не завершает poll возвратом `false`; checkpoint передаётся в `_handleControlPlaneLaunchFailure` для досборки/уведомления → **GAP-3** (частично закрыт в PR #676; точечный probe A9) |
| 3248 | `cpDispatches` или `_activeUnresolvedLaunches().length` | guard | корректно: идёт recovery запуска |
| 3250 | `cpBusyRequests` пуст | — | нормальный выход |
| 3263 | receipt невалиден (`!receipt` / несовпадение `requestId`/`profileId` / `durable !== true`) | ❌ **wedge** | тихо, без аудита → **GAP-2** (#660) |
| 3267-3273 | `/status`: 404 → terminal (A1 ✅); не-404 → `throw` | ⚠️ wedge (5xx) | ретрай без лимита → A2 (CP #280); тест «keeps the barrier on CP 500» (`tests/intake-buffer-control-plane.test.js:1883`) |
| 3276 | `row.id`/`row.profile_id` ≠ receipt | ❌ **wedge** | рассинхрон строк → **GAP-2** (#660) |
| 3286-3331 | non-terminal → route-путь: L3290 `routingRetryClaim` defer; L3296 stopPending defer; L3301 невалидный routed → `return false`; L3309 snapshot mismatch → `return false` | ❌ **wedge** (L3301, L3309) | → **GAP-2** (#660) |
| 3331 | defer после записи `routingOutcome` | defer | корректно: следующий тик |
| 3333-3334 | невалидны `generation` / `providerAcceptedAt` | ❌ **wedge** | → **GAP-2** (#660) |
| 3338-3340 | snapshot/envelope mismatch на terminal-пути | ❌ **wedge** | → **GAP-2** (#660) |
| 3352 | outbox enqueue fail / quarantine | ❌ **wedge** | инфраструктурный отказ outbox — барьер вечный; отдельный класс (нет issue: требует диагностики outbox, не CP) |
| 3354 | outbox drain fail (не-independent) | ❌ **wedge** | то же |
| 3356 | delivery ≠ `sent` | ❌ **wedge** | то же |
| 3361-3362 | release-guard: `cpDispatches` / unresolved / `busy≠true` / ids изменились | guard | корректно (INV-4) |
| 3385-3399 | catch-all: `reconciliationFailure` + `return false` | ⚠️ wedge (5xx) | ретрай без лимита → A2 (CP #280) |

## 3. Gap-реестр (issue на каждый gap)

| Gap | Суть | Issue | Якоря |
|---|---|---|---|
| GAP-1 | ~~У CP-ветки busy-релиза нет hard TTL~~ → **закрыт**: hard cap symmetric with non-CP path; `BUSY_MAX_MS` освобождает wedged busy window | #659 (#676) | `src/intake-buffer.js:3647-3666` |
| GAP-2 | Desync-пути `return false` (invalid receipt, row desync, snapshot mismatch, invalid generation) навсегда клинят poll; одной плохой записи достаточно (нет `continue`); тихо — без аудита и без сообщения пользователю | #660 | `src/intake-buffer.js:3263, 3276, 3309, 3333-3334, 3338-3340` |
| GAP-3 | ~~Ошибка `_recoverControlPlaneLaunch` клинит весь poll~~ → **wedge снят** в PR #676 (L3269); checkpoint передаётся в `_handleControlPlaneLaunchFailure` для досборки/уведомления; полный retry-test в `tests/intake-buffer-control-plane.test.js` (A9) | #661 | `src/intake-buffer.js:3247,3269` |
| GAP-4 | `/route`: 404 в poll'е → вечный ретрай (не классифицируется как unknown-outcome, в отличие от 404 на `/status`); в intake-пути ошибка глотается (`routingPending`) — пользователь не информирован | #662 | `src/intake-buffer.js:3299-3301`; `src/lib/control-plane-execution.js:162-173` |
| GAP-5 | `/start` никогда не ретрайтится poll'ом; batch lane при провале `/start` после успешного `/intake` молча оставляет принятую незапущенную задачу | #663 | `src/sandbox-tg/worker.js:139-145`; `src/sandbox-tg/conversation.js:320` |

## 4. «Gap: none» (корректно + тест)

| Путь | Почему корректно | Тест |
|---|---|---|
| `/intake` 404/500 в основном пути | барьер пре-admission: receipt не persisted → `cpBusyRequests`/`busy` не пишутся; ошибка уходит в Telegram-хендлер | `tests/control-plane-execution.test.js` — «leaves no durable receipt behind when CP /intake fails with 500/404» (добавлены в A8) |
| `/status` 404 → terminal + cleared | A1-фикс | `tests/intake-buffer-control-plane.test.js:1865` «clears the barrier when CP returns 404 for task status» |
| `/status` 500 → барьер сохранён + `reconciliationFailure` | консервативно: исход неизвестен | `tests/intake-buffer-control-plane.test.js:1883` «keeps the barrier on CP 500 during status poll» |
| `/route` ack lost в intake-пути → receipt durable сохранён | идемпотентность: повтор с тем же requestId вернёт тот же receipt | `tests/control-plane-execution.test.js:98` «keeps durable task identity when route acknowledgement is lost» |

## 5. Верификация

- baseline (R11): `test -f docs/CP-ERROR-PATHS-INVENTORY.md` — до этого PR даёт
  fail (файла нет), после — pass.
- якоря: `grep -n '<symbol>' src/intake-buffer.js` — L-номера §1–§3 сверяются с
  SHA-якорем `2b5c195`; расхождение = дрейф, правится вместе с меняющим код PR.
- код: `npm run check`; `npx vitest run tests/control-plane-execution.test.js`
  (11 тестов, включая 2 новых A8) и
  `npx vitest run tests/intake-buffer-control-plane.test.js` (153 теста).

Связанные doc: `docs/CONTROL-PLANE-BARRIER-CONTRACT.md` (A3, §3 TTL-инварианты),
`state/research/2026-10-13-a1-barrier-404.md` (research §4 — исходная таблица
`return false`).
