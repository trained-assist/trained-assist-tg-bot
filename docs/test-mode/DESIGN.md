# Тестовый режим шлюза — предложение изменения (шаг 4)

Ветка: `eng/trained-assist-product-owner-plan-f45565a2`.
Вход: `docs/user-stories/TEST-MODE.md` (US-TEST-01), `docs/test-mode/CONTEXT-MAP.md`,
`docs/test-mode/REQUIREMENTS-FLAGS.md` (все 🔴/⚫ там разрешены; решения R3/R5/R7/R8/R11
обязательны к исполнению здесь). Все ссылки на код — проверены на `origin/main` обеих
репозиториев (tg-bot `94ad057`+ветка, agent `39d679df`).

---

## 1. Proposal

**Зачем (сценарий + ценность).** US-TEST-01: владелец/автотест пишет тестовому профилю
как обычный пользователь — сообщение проходит весь путь шлюза и получает ответ настоящего
агента, но в Telegram не уходит НИЧЕГО: и отправки шлюза, и ответ агента попадают в журнал
Cloudflare, откуда их читает человек (`wrangler tail` / дашборд) и автотест. Ценность V2
(явный запрос владельца): проверять маршрутизацию на живом агенте без шума в чате и без SSH.

**Что меняется (две репозитории, два независимых PR):**

| Сторона | Изменение |
|---|---|
| шлюз (trained-assist-tg-bot) | env-список `TEST_CHAT_IDS`; все исходящие в тестовый чат подавляются и пишутся в лог `[test-mode]`; `/run` для тестового чата уходит с `delivery:"log"` и резервным (мёртвым) `chatId`; `/internal/run-finished` принимает поле `answer` и пишет его в журнал |
| агент (trained-assist-agent) | принимает `delivery:"log"` из `/run`; при нём ни одна отправка в чат не трогает Telegram (гейт в `tg-stream` — единственная точка отправки рана); финальный ответ возвращается полем `answer` в том же `run-finished` |

**Влияние.**
- Модули шлюза: новый `src/lib/test-mode.js`; `lib/telegram.js` (8 функций — гейт),
  `index.js` (`dispatchInner` — init; `/internal/run-finished` — `answer`+инверсия резервного
  id; `/internal/held-messages` — инверсия), `lib/agent-client.js` (`runTask` — swap+флаг на
  последнем хопе, `stopTask` — swap), `run-outbox.js` (swap перед `POST /run` + гейт в
  `notify`), `handlers/commands.js` (гейт cleanup-удалений + обработчик `/test_mode`),
  `lib/transient-ui.js` (гейт `retireUI`/`rejectExpiredUI`), `intake-buffer.js` (init в
  конструкторе), `commands-registry.json` (запись `/test_mode`), `wrangler.toml` (`[vars]`).
- Модули агента: `server.js:1347` (+1 поле в `runTask`), `runner/tg-stream.js` (гейт
  `tgSend`/`tgEdit`), `runner/index.js` (марк на старте рана, захват финального ответа,
  `answer` в `_finishAcceptedChatRun`), `gateway-callback.js` (+`answer` в теле).
- Контракты: два ОПЦИОНАЛЬНЫХ поля, обратно совместимых в обе стороны (старый агент
  игнорирует `delivery`, старый шлюз игнорирует `answer`).
- Данные: НЕТ (ни KV-схемы, ни DO-миграций; только `[vars]` — обычный конфиг).
- Другие сервисы: staging/CI не меняются; деплой-порядок — см. §6.

**Почему это закрывает сценарий целиком.** Ответ агента отправляет агент (CONTEXT-MAP §2) —
поэтому без agent-PR задача в принципе невыполнима. Канал `run-finished` уже есть и уже
авторизован (Bearer `AGENT_SECRET`) — новые транспорты не нужны (решение R5/R7).

---

## 2. Design

### 2.1 Ключевое решение: два слоя, включаемые ОДНИМ ветвлением

В `RunOutbox.alarm` (последний хоп перед `POST /run`) и в `runTask` прямой ветки
(когда `RUN_OUTBOX` не сконфигурирован) — одна и та же функция `applyTestDelivery(env, body)`:

```
if (!isTestChat(env, body.userId)) return false;   // обычные чаты: body не тронут, 0 проверок
body.chatId = body.userId = reserveChatId(env, body.userId);  // слой B: мёртвый id
body.delivery = 'log';                                            // слой A: флаг агенту
return true;
```

- **Слой A (контракт).** Агент при `delivery:"log"` не шлёт в Telegram (см. 2.3) и
  возвращает ответ полем `answer` в `run-finished`.
- **Слой B (страховка, решение R8).** Резервный id `= -(1e14 + i)`, где `i` — индекс чата в
  распарсенном `TEST_CHAT_IDS`. Всегда отрицательный (валидация шлюза пропускает, см.
  `index.js:41-44`), инжективный и обратимый по тому же списку:
  `realChatId(env, maybeReserve)` сканирует список и сравнивает. Если агент проигнорирует
  флаг (старая версия/баг), его отправки уходят в несуществующий чат → Telegram 400 → в
  живой чат ничего не попадает. НЕ используем `chatId 0` (опровергнут C2: web-сентинел).
- Флаг и подмена всегда ставятся В ОДНОМ ветвлении → рассинхрона «подменён, но без флага»
  в коде шлюза невозможен.

Swap живёт на последнем хопе намеренно: вся остальная логика шлюза (outbox FIFO-ключ
`${username}:${userId}`, `job.chatId` для notify, снапшот интейка, group-history ack,
`conversationKey`) работает с РЕАЛЬНЫМ id и не меняется вовсе. На проводе к агенту резерв,
внутри шлюза — реальный.

**Резервный id участвует в обратной связи:** `run-finished` и `held-messages` приходят с
резервным id → функция `realChatId` переводит его обратно перед `conversationKey(...)` —
иначе `busy` не отпустится (чужой DO). Аналогично `stopTask`: `/stop` в тестовом чате
переводит chatId в резерв перед `POST /tasks/stop`, иначе агент не найдёт ран (liveRuns
зарегистрирован под резервным).

### 2.2 Шлюз: подавление отправок

Новый `src/lib/test-mode.js` (всё синхронно, без `await` — требование R14):

- `isTestChat(env, chatId)` — парсит `env.TEST_CHAT_IDS` (список через запятую), мемо по
  сырой строке; сравнение по `Number`. Нет переменной / пусто / мусор → `false`
  (fail-safe R13). Никогда не матчит чужой чат: вход — только явный список.
- `initTestMode(env)` — кладёт распарсенный список в модульный кэш для функций
  `lib/telegram.js`, которые получают только `token` (менять сигнатуры 8 функций и десятки
  вызовов — дороже и шире гейта). Три точки init (проверено: этого достаточно, чтобы
  ВСЕ импортёры `telegram.js` были покрыты):
  1. верх `dispatchInner` (`src/index.js:242`) — все вебхук-апдейты;
  2. конструктор `IntakeBuffer` (`src/intake-buffer.js:157`) — все отправки накопителя;
  3. `processDueRetries` (`src/handlers/message.js:342`) — cron-ретраи из `scheduled()`.
  `initTestMode` идемпотентен и дёшев; неинициализированный кэш = обычные отправки
  (тот же fail-safe; страховка — тесты на все три входа + смоук §5).
- `suppress(chatId, kind, detail)` → `console.log('[test-mode] kind=<fn> chat=<id>
  text=<первые 300 символов>…')`, возвращает заглушку `{ok:true, suppressed:true}` без
  `result` — вызывающий код не падает, `recordSent`/`trackUI` при `suppressed` не вызываются
  (иначе в KV попадут записи о несуществующих сообщениях).

**Гейты:**

| Место | Что | Проверка |
|---|---|---|
| `lib/telegram.js` | `sendMessage`, `editMessage`, `editMessageReplyMarkup`, `pinChatMessage`, `unpinChatMessage`, `deleteMessage`, `sendDocument` | `if (isTestChat(env, chatId)) return suppress(...)` — до fetch |
| `lib/telegram.js:167` `answerCallbackQuery` | нет chatId в аргументах | реестр: `dispatchInner` перед `handleCallbackQuery` зовёт `rememberCallback(cq.id, cq.message?.chat?.id)`; `answerCallbackQuery` матчит `callbackQueryId` по реестру (TTL-очистка, cap 256) |
| `lib/telegram.js:158` `sendMessageWithKeyboard` | обёртка над `sendMessage` | покрыта автоматически + `if (result.suppressed) return` до `trackUI` |
| `run-outbox.js:98 notify` | свой fetch | `isTestChat(this.env, job.chatId)` → `console.log` + return (job.chatId — реальный, см. §2.1) |
| `handlers/commands.js:699,709` | `deleteMessages`/`deleteMessage` (cleanup-flood) | `isTestChat(env, chatId)` перед fetch |
| `lib/transient-ui.js:28 telegram` | `retireUI`/`rejectExpiredUI` | свой helper `isTestChat(env, cq.message.chat.id)` — env под рукой |

Не подавляются (осознанно): read-only вызовы (`getWebhookInfo`/`getMe`/`getChatMemberCount`,
`setMyCommands`), скачивание файлов (`getFile`) — их нет в R4, они не создают сообщений.

**Журнал (решение R7):** только `console.log` + включённый `[observability]` (Persistent
Workers Logs, ~3 дня). Никаких эндпоинтов и хранилищ. Форматы строк (по ним пишется
автотест):

```
[test-mode] run-start chat=<реальный id> requestId=<id> delivery=log
[test-mode] kind=sendMessage chat=<id> text=<300 символов>…
[test-mode] kind=run-finished chat=<id> requestId=<id> outcome=done|error|stopped|quick
[test-mode] kind=agent-answer chat=<id> requestId=<id> len=<n> text=<до 4000 символов>
```

`/internal/run-finished` (`src/index.js:36-58`): + `answer` (string, defensive-обрезка до
8000). Логируется когда `isTestChat(env, realChatId)` ИЛИ `answer` присутствует; в DO
(`intake/run-finished`) уходит прежний `{requestId, consumed}` — схема накопителя не
меняется. Идемпотентность R9: повтор даёт повторную строку лога, автотест дедуплицирует по
`requestId` (как и договорено в C4).

**`/test_mode` (решение R11):** только чтение. Запись `{command:"/test_mode",
handler:"local", adminOnly:true, audiences:[...]}` в `commands-registry.json` + обработчик
в `handlers/commands.js`, отвечающий: сколько чатов в `TEST_CHAT_IDS`, и «этот чат:
тестовый/обычный». В `dispatchInner` admin-ветка (`src/index.js:284-297`) сейчас
пропускает только user-mgmt и forward-команды — расширить условие на local-команды с
`adminOnly:true` из реестра. Включение/выключение — только правка `[vars]` (второго
источника состояния нет).

**Конфиг:** `TEST_CHAT_IDS = ""` в `[vars]` всех окружений по умолчанию (релиз выезжает с
ВЫКЛЮЧЕННЫМ режимом, см. §6). Staging — пустой список, KV изоляция не затрагивается.

### 2.3 Агент: гейт отправок и поле `answer`

- **`server.js:1347`** (durable `/run`, явный список полей в `runTask(...)`): +
  `delivery: payload.delivery === 'log' ? 'log' : null`. (`taskDelivery {…opts}` в
  `bot-delivery.js:35` разнесёт поле дальше по opts — R6.)
- **`runner/tg-stream.js`** — единственная точка отправки рана (все ~40 вызовов в
  `runner/index.js` идут через `tgSend`/`tgEdit`; проверено `git grep`):
  + `markLogChat(chatId)` / `isLogChat(chatId)` (множество, процесс);
  + в `tgSend` и `tgEdit` сразу после `hasTelegramChat`: `if (isLogChat(chatId)) {
    console.log('[test-mode] agent-suppress kind=send|edit chat=… len=…');
    return { ok:true, skipped:'test-mode', result:null }; }` — без сети, без форматтера,
    без записи в `sent-messages`. Ничего не бросает → ран не может умереть от 400.
- **`runner/index.js`**: в обёртке `runTask` (~:940, рядом с `acceptedChatId`) —
  `if (delivery.delivery === 'log' && acceptedChatId != null) markLogChat(acceptedChatId)`;
  в блоке финального ответа (~:3806, до `tgEdit(…, \`🧠 ${final}\`)`) —
  `if (opts.delivery === 'log') recordRunAnswer(opts.taskId, final)` (Map с cap 64);
  в `_finishAcceptedChatRun` (~:641) — `answer = opts.delivery === 'log' ?
  takeRunAnswer(opts.taskId) : null` → `notifyRunFinished({…, ...(answer && {answer})})`.
  Ошибочные/стоп-исходы `answer` не несут — их видно по `kind=run-finished outcome=…`.
- **`gateway-callback.js:64`**: параметр `answer` → поле тела (обрезка до 8000 до отправки).
- Что НЕ покрывается гейтом (аудит выполняется слайсом A4, следствие урезанного R3):
  прямые `api.telegram.org` вне `tg-stream` — MCP-артефакты (`94-tg-send`, `95-illustrate`,
  `96-label`), `handlers/connect.js`, `gtd-controller` и др. В тестовом чате их дёшево
  глушит слой B (мёртвый chatId → 400), но это НЕ контракт: их ошибки не попадают в журнал
  тестового прогона, автотест на них не полагается. Явное ограничение (решение R3).

### 2.4 Почему не проще альтернатив (отклонённые)

- Подмена `TELEGRAM_API_URL` на фейковый эндпоинт — шлюз уважает её только при скачивании
  файлов, не в отправке (CONTEXT-MAP §4); пришлось бы править каждый fetch + не покрывает агента.
- Изменить сигнатуры 8 функций `telegram.js` (+env) — десятки вызовов, шире гейта.
- KV-вкл/выкл режима — второй источник истины + миграция (решение R11).
- Отдельный `/internal/test-answer` — R7 отклонён (новая неаутентифицированная поверхность,
  дубль транспорта); `answer` едет существующим `run-finished` (R5).
- 40 гейтов в агенте по местам вызовов — R3 урезан; chokepoint `tg-stream` закрывает
  основное одной проверкой.
- `chatId 0` — опровергнут (C2).

---

## 3. Spec delta (`docs/user-stories/TEST-MODE.md`)

- **МЕНЯЕТСЯ шаг 4:** слой A = `delivery:"log"` + ответ полем `answer` в СУЩЕСТВУЮЩЕМ
  `POST /internal/run-finished` (не `/internal/test-answer`); слой B = резервный
  отрицательный `chatId` `-(1e14+i)`, а не `0` (с инверсией на входе `run-finished` /
  `held-messages` и в `stopTask`).
- **МЕНЯЕТСЯ шаг 6:** `/test_mode` — только статус; «убрать из режима» = убрать chatId из
  `TEST_CHAT_IDS` (правка конфига + рестарт шлюза), не `/test_mode off`.
- **МЕНЯЕТСЯ крайний случай про артефакты агента:** до agent-PR их судьба — слой B (мёртвый
  chatId): в чат не доходят, но ошибка не в журнале; после agent-PR основные отправки идут
  через гейт `tg-stream`. Полагаться на подавление артефактов автотест не может.
- **МЕНЯЕТСЯ крайний случай «Старый агент»:** работает только в окно между деплоем шлюза и
  агента; порядок выпуска фиксируется в §6, `TEST_CHAT_IDS` включается последним.
- **ДОБАВЛЯЕТСЯ ограничение:** спонтанные отправки агента вне рана (GTD-напоминания,
  `/connect`) с реальным chatId возможны только из хвоста ДО-включения режима; новые раны
  сохраняют резервный id — напоминания уходят в мёртвый чат (тишина — ожидаемо).
- **УДАЛЯЕТСЯ:** ничего.

---

## 4. Срезы (порядок и тест каждого)

**Трек A — агент (`trained-assist-agent`), ПЕРВЫМ (см. §6):**

| # | Срез | Тест |
|---|---|---|
| A1 | `server.js`: прокидка `delivery` в `runTask` | unit: `/run` с `delivery:"log"` → opts дошёл; без поля → `null` |
| A2 | `tg-stream.js`: `markLogChat`/`isLogChat` + гейты в `tgSend`/`tgEdit` | unit (mock `fetch`): помеченный чат → 0 fetch, возврат `{ok:true, skipped}`; не помеченный → fetch (существующие `tests/runner-e2e` не падают) |
| A3 | `runner/index.js` + `gateway-callback.js`: марк на старте, `recordRunAnswer`, `answer` в `notifyRunFinished` | unit: флаг → в теле `run-finished` есть `answer` (обрезан); без флага → поля нет; повтор `takeRunAnswer` — одноразовый |
| A4 | Аудит прямых отправок вне `tg-stream` (connect/GTD/MCP) — обработка 400 без падения рана; выводы → примечанием в этот файл | ручной прогон смоука + `npm run check` |

**Трек G — шлюз (`trained-assist-tg-bot`, эта ветка):**

| # | Срез | Тест |
|---|---|---|
| G1 | `src/lib/test-mode.js`: `isTestChat`/`initTestMode`/`suppress`/`reserveChatId`/`realChatId`/`rememberCallback` | unit: fail-safe (нет переменной/пусто/мусор → false); отрицательные group-id матчатся; обратимость резерва; инвариант «не-тестовый чат никогда не матчится» |
| G2 | Гейты в `lib/telegram.js` (7 функций + `answerCallbackQuery` по реестру) + `sendMessageWithKeyboard`→без `trackUI` при suppressed | unit: init с тестовым id → 0 вызовов `fetch`; обычный чат → fetch вызван; callback-ack подавляется только зарегистрированный |
| G3 | Init-точки (`dispatchInner`, конструктор `IntakeBuffer`, `processDueRetries`) | unit: dispatch тестового апдейта → journal-строка и ни одного sendMessage (интеграция через `worker.fetch` как в `tests/internal-run-finished.test.js`) |
| G4 | Обходы: `run-outbox notify`, `commands.js` cleanup, `transient-ui` | unit по каждому: тестовый чат → journal, сети нет; обычный → fetch |
| G5 | `/internal/run-finished`: `answer`+логирование; инверсия резервного id в `run-finished` и `held-messages` | расширить `tests/internal-run-finished.test.js`: резервный id → stub реального чата; `answer` → строка `kind=agent-answer`; чужой чат без `answer` → без journal-шума |
| G6 | `runTask`/`RunOutbox.alarm`/`stopTask`: `applyTestDelivery` на последнем хопе + строка `run-start` | unit: тело `/run` тестового чата = резерв+`delivery:"log"`; обычного — байт-в-байт прежнее; `job.chatId` outbox остаётся реальным; `stopTask` переводит id |
| G7 | `/test_mode` (реестр + обработчик + admin-ветка `dispatchInner`) | unit: из админ-группы → статус; из чужого чата → `adminOnlyHint`; `scripts/check-commands-registry.mjs` зелёный |
| G8 | `wrangler.toml` `[vars] TEST_CHAT_IDS=""` + комментарий | `npm run check`; staging smoke без изменений поведения |

Порядок: G1→G2→G3 (ядро) → G4→G5→G6 → G7→G8. A1→A2→A3→A4 параллельно треку G.
Всё коммитится в ветку `eng/trained-assist-product-owner-plan-f45565a2` до конца шага
реализации; agent-трек — вторым workspace того же `root_task_id` в репо агента.

---

## 5. План проверки (шаг сценария → проверка)

| Шаг US-TEST-01 | Проверка | Уровень |
|---|---|---|
| 1 (флаг, дефолт выкл) | G1 unit fail-safe + G8: staging с пустым списком — поведение прежнее | S1 |
| 2 (путь маршрутизации, отправки в журнал) | G3 интеграция: апдейт тестового чата → 0 `sendMessage`-fetch + journal-строка; существующие intake-тесты зелёные | S1 |
| 3 (`/run` c `delivery`+резервом) | G6 unit | S1 |
| 4 (ответ не в чате, а слой A) | A2+A3 unit (сеть не трогается, `answer` в callback) | S1 |
| 5 (запись в журнале, 0 отправок) | Шаг 6 плана «Песочница»: замкнутый цикл — воркер + фейковый агент (стаб `/run`, отдающий `run-finished` с `answer`) + перехват `fetch`; ассерт: строка `kind=agent-answer` есть, к api.telegram.org с тестовым `chat_id` — 0 обращений | S2 |
| 6 (снятие флага → обычное) | G1 unit + ревью: все гейты синхронные, до `await` | S1 |
| Целое | CI: `npm test` + `npm run check` (без LLM-судьи, #271) + staging-gate зелёный (R15); смоук на проде — шаг 13 плана: сообщение в тестовый чат → journal-строки в CF-dashboard, ответ в `kind=agent-answer`; контрольный обычный чат — без изменений | S3→S4 |

Остаточный риск урезанного объёма R3 (агентские артефакты) закрывается смоуком: в тестовом
чате за прогон — ноль сообщений; если артефакт протёк — это не регрессия флага, а
задокументированное ограничение (§2.3).

### 5.1 Результат проверки в реальном окружении (02.10.2026)

Полный отчёт: `prod-check/test-mode-live-2026-10-02.md` (проект recruiting); версии в
проде — шлюз `9a8647a` (PR #330), агент `b9be3ba` (PR #2023 + фикс R2 #2027).

| Шаг сценария | Живая проверка | Итог |
|---|---|---|
| 4 — ответ агента не в чате | реальный ран `delivery:"log"` → `agent-suppress` в журнале агента, в Telegram 0 сообщений | ✅ подтверждено (прогоны A, C) |
| 5 — `kind=agent-answer` в журнале шлюза | строка `[test-mode] kind=agent-answer … text=ТЕСТРЕЖИМ-ОК` в Workers Logs | ✅ подтверждено (прогоны A, C) |
| 6 — снятие флага → чат живой | контрольный прогон без флага: реальная отправка в Telegram (400 от мёртвого резервного id — для живого чата это обычный ответ) | ✅ подтверждено после фикса R2 (#2027); до фикса — ПРОВАЛ (метка не снималась, чат молчал до рестарта) |
| 1 — гейт шлюза вживую | — | ⏭ режим выключен в проде (`TEST_CHAT_IDS` пуст) по дизайну; покрыто песочницей и `scenario-gate` |
| 2–3 — входящая нога вживую | — | ⏭ невозможно: `TELEGRAM_WEBHOOK_SECRET` в Cloudflare только для записи (API отдаёт имена, не значения), подделать вебхук нельзя. Покрыто автотестом `npm run test:scenario` (12/12, цикл S5) и CI-гейтом `scenario-gate` |

Дефект, найденный живой проверкой: **R2** — метка log-чата не снималась на завершении
рана (шаг 6 не выполнялся, чат молчал до рестарта процесса). Фикс в коде агента:
`trained-assist-agent` PR #2027 (`Set` → `Map` со счётчиком, снятие в
`_finishAcceptedChatRun` на любом исходе рана), с регрессионным e2e (без фикса падает).

---

## 6. Риски и откат

| Риск | Цена | Прикрытие |
|---|---|---|
| Гейт пропустил путь отправки | тестовый шум в тестовом чате (виден сразу, живым не вредит) | инвентарь §2.2 проверен по коду; смоук «ноль сообщений» |
| `initTestMode` не вызван на каком-то входе | подавление молча выключено | 3 точки init покрывают всех импортёров (проверено); тест на каждый вход; смоук |
| Баг `isTestChat` вернёт true для живого чата | живой пользователь молчит — самое тяжёлое | дефолт false; unit-инвариант «не из списка → false»; **релиз выезжает с пустым `TEST_CHAT_IDS`, включение — отдельным конфигом после проверки** |
| Новый шлюз + старый агент | тестовые раны умирают на 400 статус-сообщений (слой B без слоя A) | порядок выпуска: **агент → шлюз → включить `TEST_CHAT_IDS`**; до включения списка последствий нет вообще |
| Правка `TEST_CHAT_IDS` во время летящего рана | `busy` чата не отпустится до `BUSY_MAX_MS` (резерв не инвертируется) | известный край; править конфиг вне прогонов (runbook в шаге 15) |
| PII в логах | ответы в Workers Logs ~3 дня | осознанно (R7/R18); эндпоинтов и KV нет |
| Спонтанные GTD-напоминания профиля «с докомода» | доставка в реальный тест-чат до первого нового рана | ограничение §3; новый ран сохраняет резерв — само лечится |

**Откат.**
1. Мгновенный, без деплоя: очистить `TEST_CHAT_IDS` → весь шлюз-слой инертен; агент без
   `delivery` в `/run` — полностью в обычном режиме (флаг опционален).
2. Git: revert мерж-коммитов двух PR независимо; контракты опциональны → старый шлюз
   игнорирует `answer`, старый агент игнорирует `delivery` — откат любой стороны безопасен
   в любую сторону.
3. Миграций данных нет (KV/DO не трогаются) — откат не требует возврата состояния.

**Порядок выпуска:** 1) смержить и задеплоить agent-PR; 2) смержить и задеплоить
gateway-PR (флаг `TEST_CHAT_IDS` пуст); 3) выставить `TEST_CHAT_IDS` нужного окружения;
4) смоук §5; 5) откат = п.1.
