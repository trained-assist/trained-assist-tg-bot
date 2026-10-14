# CONTROL-PLANE-BARRIER-CONTRACT — контракт барьера Intake↔CP

**Роль/задача:** worker, A3 (BACKLOG «Этап A»)
**Дата:** 2026-10-13
**SHA-якорь:** `b8f58ef` — все L-номера в этом файле сверены с `src/intake-buffer.js`
на этот коммит; при дрейфе строк обновлять якоря в том же PR, что двигает код.

## 0. Scope

Барьер — busy-окно шлюза (tg-gateway, Durable Object `IntakeBuffer`), пока
задача Control Plane (CP) в полёте: от первого запуска батча до снятия hold'а.
Контракт фиксирует: durable-состояние, state machine, TTL-инварианты,
владельцев каждого перехода, наблюдаемость без логов (связано с A7) и
соответствие коду на дату SHA-якоря.

Вне scope: внутренняя механика `cpStopWindow` (стоп-окно пересекается с
барьером, но имеет свой state machine — здесь только точки пересечения);
legacy-режим `EXECUTION_BACKEND != control-plane` (упоминается для сравнения
TTL); стороны CP и Runner.

«Запись» = один barrier-entry: `launchKey` в `cpUnresolvedLaunches` и/или
`requestId` в `cpBusyRequests`.

## 1. Durable-состояние

Барьер двухслойный: pre-admission слой (`unresolved`) и admitted слой
(`cpBusyRequests`). Состояние живёт только в keys DO storage — не в логах.

| Ключ DO | Что значит | Пишет | Стирает |
|---|---|---|---|
| `busy`, `busySince`, `busyChatId`, `busyThread` | окно занято (hold на чат) | `_dispatch` (L2638–2643); POST `/cp-acceptance` (L899) | только `_releaseBusyLocked` (L2845) |
| `cpUnresolvedLaunches` | set `launchKey` — unresolved записи (admission не подтверждён) | `_dispatch` (L2633) | `_recordControlPlaneAck` (L3123); `_handleControlPlaneLaunchFailure` (L2940); `_releaseBusyLocked` (L2847) |
| `cp-launch:{launchKey}` | checkpoint батча для recovery | `_dispatch` (L2628) | L3124, L2941, operator reset |
| `cpBusyRequests` | set `requestId` — admitted записи (ядро барьера) | POST `/cp-acceptance` (L895–901); `_recordControlPlaneAck` (L3113–3115) | `_releaseBusyLocked` (L2846) |
| `cp-acceptance:{requestId}` | record: `receipt`, `terminal`, `outcomeUnknown`, `routingOutcome`, `routingRetry*`, `reconciliationFailure`, `stale` (#267) | POST `/cp-acceptance` (L896); poll (L3320, L3365, L3372, L3396); stale-sweep `_dropStaleControlPlaneLocks` (#267) | не стирается — durable-аудит (только operator reset) |
| alarm | тик поллинга | `setAlarm` / `_ensureAlarmBy` | `_releaseBusyLocked` (L2862) |

Единственная точка снятия барьера — `_releaseBusyLocked` (L2845): удаляет оба
слоя + `busy` + alarm за одной транзакцией. Пост-снятие — `_afterBusyRelease`
(L2867): media-recovery, re-offer held-ввода, `launchAfterRelease`.

## 2. State machine

```
                     ┌──────────────── no_admission ──────────────┐
                     │  (explicit отказ до receipt; батч → retry) │
                     ▼                                            │
 (нет) ──▶ unresolved ──admission──▶ admitted ──route──▶ admitted(routed)
             │  ▲                       │                     │
             │  │ recovery              │ 404 / status unknown│
             │  └───────────────────────┴──▶ unknown_outcome ──┤
             │                              (record flag)      │
             │ user dismiss                                    │
             ▼                                                 ▼
        unknown_outcome                          delivered (outbox sent)
             │                                              │
             └───────────────▶ cleared ◀────────────────────┘
                    (5xx/timeout →НЕ cleared: reconciliationFailure,
                     барьер живёт до A2-лимита)
```

Состояния:

- **unresolved** — батч записан, durable receipt ещё нет.
- **admitted** — receipt durable, `requestId ∈ cpBusyRequests`. Подсостояния:
  `routed` (`routingOutcome.known && publicationComplete`);
  `reconciliation-failed` — не отдельное состояние, а annotation поверх
  admitted (исход неизвестен, ждём следующего тика).
- **delivered** — терминальный результат задачи enqueue'нут в outbox, delivery
  `sent`.
- **cleared** — барьер снят (`_releaseBusyLocked`).
- **no_admission** — CP отказал до записи receipt → checkpoint retired,
  батч в `retryBatch`.
- **unknown_outcome** — исход не определить; флаг на record
  (`terminal: true` при 404 — A1; `outcomeUnknown: true` при status unknown)
  или `userDismissed` на `cp-launch`; барьер снимается.

### Переходы и владельцы (на SHA `b8f58ef`)

| # | Переход | Триггер | Владелец | Код |
|---|---|---|---|---|
| 1 | (нет) → unresolved | диспатч батча: checkpoint + `cpUnresolvedLaunches` + `busy` | `_dispatch` | L2622–2643 |
| 2 | unresolved → admitted | CP intake вернул durable receipt → persist в DO | `runControlPlaneTask` (`src/lib/control-plane-execution.js:34`, POST L130) → POST `/cp-acceptance` | L866–903 |
| 3 | unresolved → admitted (финализация) | ack после handleMessage; retire `launchKey` | `_recordControlPlaneAck` | L3102–3126 |
| 4 | unresolved → recovery | тик поллинга (L3247) / свежий текст при непустом raw-set (L1641–1646); дальше poll идёт только при пустом active-set (L3248) | `_recoverControlPlaneLaunch` | L3128–3179 |
| 5 | unresolved → no_admission | `CONTROL_PLANE_NO_ADMISSION` либо 401/403 **без** durable receipt | `_handleControlPlaneLaunchFailure` | L2908–2955; из timeout/5xx no_admission **не выводится** (L2919–2923) |
| 6 | unresolved → unknown_outcome (dismiss) | «⏸ Не ждать старую задачу» в stop-flow | POST `/dismiss-unknown` (CP-ветка) | L783–801; dismissed исключается из active-set (`_activeUnresolvedLaunches` L365–372) |
| 7 | admitted → admitted(routed) | route при non-terminal статусе задачи (в т.ч. degraded-публикация) | `_pollControlPlaneTasks` route-stage | L3292–3331 |
| 8 | admitted → delivered → cleared | статус `done/failed/cancelled` → enqueue `terminal:{taskId}:g{gen}` → outbox `sent` → cleanup | `_pollControlPlaneTasks` | L3341–3358, release L3360–3379 |
| 9 | admitted → unknown_outcome → cleared | **CP 404 на `/status`** (A1) | `_pollControlPlaneTasks`, per-request catch | L3266–3274 |
| 10 | admitted → unknown_outcome → cleared | task/runs `status=unknown` (settled, `awaiting` не open) | `_pollControlPlaneTasks` | L3279–3285, L3369–3373 |
| 11 | admitted → admitted + `reconciliationFailure` | 5xx/timeout — исход неизвестен, барьер сохраняется | catch `_pollControlPlaneTasks` | L3385–3400 |
| 12 | * → cleared | единственная точка снятия (guard см. ниже) | `_releaseBusyLocked` + `_afterBusyRelease` | L2845–2899 |
| 13 | admitted → stale → cleared | latch-id без matching (current-profile, durable) `cp-acceptance` — снять немедленно, не ждать BUSY_MAX_MS (**#267**) | `_dropStaleControlPlaneLocks` (вызов из `_pollControlPlaneTasks`) | L3294–3301, L3489–3524 |

Замечания:

- Identity-guard: несовпадение receipt/`taskStore` с ожиданиями → `return false`
  (остаёмся admitted, ретрай следующим тиком): L3263, L3276. Одинаково
  консервативно: при смене `cpBusyRequests` между поллингом и release-guard
  release не происходит (L3362).
- **#267 stale-latch sweep (#267):** до фикса запись `cpBusyRequests` без
  matching `cp-acceptance` (invalid/missing receipt, см. §3) клинца поллинг в
  `return false` до BUSY_MAX_MS (45 мин молчания чата). Sweep до цикла
  реконсиляции помечает такие id `stale: true` +
  `reconciliationFailure{stage:'acceptance', errorName:'StaleControlPlaneLatch'}`,
  удаляет их из `cpBusyRequests` и, если нечего больше реконсилировать, снимает
  busy в той же транзакции (`_releaseBusyLocked`). Release-guard sweep'а
  повторяет проверки основного: `_exclusive`, re-read списка (идемпотентность
  повторных тиков), `cpDispatches == 0`, `cpUnresolvedLaunches` пуст,
  `cpStopWindow` не pending, `busy == true`.
- Release-guard (L3360–3362): под `_exclusive`; release только если
  `cpDispatches == 0`, `cpUnresolvedLaunches` **пуст (сырой список)**,
  `busy == true` и `cpBusyRequests` не изменился с начала поллинга.
  `userDismissed` записи остаются в сыром списке до retire (ack/failure/
  release) — консервативно: не-retired checkpoint держит hold.
- Stop-flow: `cpStopWindow.admissionRequestIds/admissionLaunchKeys` добавляются
  поверх основного барьера (L3117–3121, L1370); внутренности стоп-окна — вне
  scope этого контракта.

## 3. TTL-инварианты

**INV-1 — Ограниченное время жизни.** У каждой записи барьера есть конечный
срок жизни; барьер не может ждать вечно.

| Механизм | Значение | Статус |
|---|---|---|
| cadence поллинга | `BUSY_POLL_MS = 60s` (L80), re-arm при `!released` (L3628–3629) | ✅ |
| hard cap (non-CP) | `BUSY_MAX_MS = 45 min` → release (L3633–3650) | ✅ |
| CP 404 → снятие немедленно | A1, PR #655 (L3266–3274) | ✅ |
| CP 5xx/timeout → **ограниченные** ретраи | сейчас ретраи не ограничены (L3385–3400) | ❌ **A2** |
| stale latch (нет matching acceptance) → снятие немедленно | #267: `_dropStaleControlPlaneLocks` снимает busy без ожидания BUSY_MAX_MS | ✅ |
| hard cap в CP-ветке | не применяется: alarm-ветка CP только поллит (L3627–3631) | ❌ **нарушение INV-1 → A2** |

Следствие: при устойчивой недоступности CP запись admitted живёт неограниченно
— именно этот класс дефектов закрывает A2 (BLOCKED: ждёт ревью плана-диагноза
владельцем). КонTRACT до закрытия A2 считается частично невыполненным в этой
части — см. §5.

**INV-2 — durable-only приёмка.** Вердикт по барьеру (снят/не снят, исход
задачи) принимается только по durable-состоянию (keys DO + task store CP через
`POST /status`); логи — диагностика (A7). Наблюдение — §4.

**INV-3 — изоляция ошибок записи.** Ошибка одной записи не должна останавливать
поллинг остальных. Сейчас: 404 → `continue` по циклу ✅ (A1); 5xx/timeout →
`throw` прерывает цикл, остальные записи ждут следующего тика — текущее
ограничение, закрывается A2.

**INV-4 — атомарность и единственный писатель.** Все мутации барьера — под
`_exclusive` / транзакциями DO; флаги `terminal`/`outcomeUnknown` +
`_releaseBusyLocked` выполняются одной транзакцией (L3363–3375); состояние
безопасно при повторных тиках (idempotence).

**INV-5 — один ход на чат.** Пока барьер поднят, новый ввод буферизуется
(held), второй ход не стартует: `_dispatch` отказывает при `busy` (L2603),
`/held` отдаёт буфер (L1457–1464).

## 4. Наблюдаемость (durable, не логи)

- `/debug` state dump → `controlPlaneBarrier: { unresolvedLaunchCount,
  busyRequestCount, stopPending }` (L1062–1067). **#267:** добавлен
  `busyRequests: [{ requestId, userTaskId, terminal, outcomeUnknown, stale }]`
  — operator reconcile без внутреннего KV-доступа (L1052–1058, L1085–1091).
- `/operator/test-evidence` → per-task `routingOutcome`,
  `reconciliationFailure`, `routingRetryCount` + счётчики барьера (L433–502).
- Record-флаги: `terminal`, `outcomeUnknown`,
  `reconciliationFailure { stage, httpStatus, errorName, at }`.
- Сквозная корреляция lifecycle-событий по `requestId`/`taskId` —
  `docs/LIFECYCLE-LOGGING.md` (A5).

## 5. Соответствие коду (на `b8f58ef`)

| Пункт контракта | Статус | Evidence |
|---|---|---|
| 404 → terminal unknown-outcome + cleared | ✅ | A1 PR #655 (L3266–3274); `tests/intake-buffer-control-plane.test.js` («clears the barrier when CP returns 404», «keeps the barrier when CP returns 500») |
| status unknown → `outcomeUnknown` + cleared | ✅ | L3279–3285, L3369–3373 |
| no_admission только по explicit-отказу | ✅ | L2924–2927 |
| release-guard атомарен | ✅ | L3360–3375 |
| cadence 60s; non-CP cap 45 min | ✅ | L80, L3633–3650 |
| 5xx/timeout → ограниченные ретраи | ❌ A2 | catch L3385–3400 — лимита нет |
| hard TTL в CP-ветке | ❌ A2 | L3627–3631 — cap не вызывается |
| ошибка одной записи не прерывает остальных | ❌ A2 | `throw` L3273 прерывает цикл |
| сообщение пользователю при 404-unknown | ❌ A2 | A1 снимает барьер без уведомления (BACKLOG A2: «+ сообщение пользователю») |
| stale latch → release без BUSY_MAX_MS (#267) | ✅ | `_dropStaleControlPlaneLocks` L3489–3523; тесты «releases a stale latch id…», «drops only the stale ids…», «treats a profile-mismatched acceptance record as a stale latch», «exposes busy latch requestIds and userTaskIds in /debug» |
| identity-проверка canary, хэшированные busyRequestIds/launchKeys | 🔍 A4 | IN_REVIEW, tg-bot PR #640 |
| приёмка canary без логов | 🔍 A7 | TODO |

После лёжа A2 эту таблицу обновить (тот же PR) и перепроверить якоря.

## 6. Верификация

- baseline (R11): `test -f docs/CONTROL-PLANE-BARRIER-CONTRACT.md` — до этого
  PR даёт fail (файла нет), после — pass.
- якоря: `grep -n '<symbol>' src/intake-buffer.js` — L-номера §1–§4 сверяются
  с SHA-якорем; расхождение = дрейф, правится вместе с меняющим код PR.
- код: `npm run check`; `npx vitest run tests/intake-buffer-control-plane.test.js`
  (153 теста, включая 404/500-покрытие A1).

Связанные doc: `docs/LIFECYCLE-LOGGING.md` (A5), `docs/SELF-TEST-ENV.md` (S1).
