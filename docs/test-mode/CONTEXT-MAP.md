# Тестовый режим шлюза — карта контекста (шаг 2 «Исследование»)

Дата: 2026-10-01. Ветка: `eng/trained-assist-product-owner-plan-f45565a2` (tg-bot @ `0aa8541`).
Сторона агента — `trained-assist/trained-assist-agent` @ `origin/main` (`d2fab4c4`+).
**Важно:** локальный чекаут `/home/vova/trained-assist-agent` стоит на старой ветке
`pr-1446-fix3` и не содержит ни `gateway-callback.js`, ни `live-inbox.js` — читать
agent-side только через `git show origin/main:<path>` / GitHub, иначе выводы будут ложными.

---

## 1. Карта пути сообщения (tg-bot)

```
POST /webhook → src/index.js:186 handleWebhook
             → :242 dispatchInner (бот-контекст resolveBotContext, симптомы/админ-группа)
             → :396 routeText (группы: group-routing, форум-топики: conversation-context)
             → src/handlers/message.js handleText / IntakeBuffer (DO) — накопитель
             → flush / кнопка «▶️ Запустить» → _dispatch
             → src/lib/agent-client.js:111 runTask  → env.RUN_OUTBOX (RunOutbox)
             → POST {AGENT_URL}/run   ← ответ агента в шлюз НЕ возвращается
```

Обратный канал агент → шлюз (единственный, уже есть):
`POST /internal/run-finished` — `src/index.js:36-59` (Bearer `AGENT_SECRET`,
валидация `chatId`/`threadId`/`requestId`) → `intake/run-finished` в DO
(`src/intake-buffer.js:456`) — отпускает `busy`, дропает `consumed`.
Второй обратный канал: `GET /internal/held-messages` — `src/index.js:64` (live inbox).

## 2. Кто реально отправляет ответ (это и есть главный факт)

Ответ агента уходит **самим агентом**, не шлюзом:

- `agent origin/main:src/runner/index.js:70` → `tgSend/tgEdit` из `src/runner/tg-stream.js:69,159`,
  токен — профильный `secrets.BOT_TOKEN` (`src/bot-delivery.js:15 deliverySecrets`).
- Финальный ответ — ветка `runner/index.js:~2992-2993` (`tgEdit(BOT_TOKEN, chatId, im, body)`);
  сюда же ведут таймаут/wrap_up/ошибка/стоп — их не меньше 12 точек отправки
  (`rg "tgEdit|tgSend" src/runner/index.js` → ~40 мест, включая квитанции и `inputInspectionRows`).
- `runTask` в шлюзе — fire-and-forget: `/run` возвращает 202 после журналирования,
  текста ответа в теле нет.

**Следствие (дизайн-инвариант):** шлюз физически не имеет текста ответа агента.
Пока нет нового транспорта «агент → шлюз: текст», задача «ответ в журнал» невыполнима
никаким гейтом в шлюзе.

## 3. Готовый транспорт для ответа — переиспользовать, не плодить

`agent origin/main:src/gateway-callback.js:64 notifyRunFinished({chatId, threadId,
requestId, taskId, outcome, consumed, audience, secret})` — единственная точка
«ран урегулирован», вызывается из `runner/index.js:614 _finishAcceptedChatRun`
(все исходы: done / error / stopped / quick). Уже несёт `outcome`, `requestId`,
`taskId`. **Ответ агента логично ехать тем же запросом новым полем `answer`** —
новая схема/авторизация/точка отказа не появляются, и релиз `busy` идёт тем же
запросом (нельзя делать два разных коллбэка: второй может потеряться отдельно).

Проброс флага из шлюза в агент — дешёвый: `taskDelivery` (`bot-delivery.js:21`)
делает `{...opts}`, поэтому любое новое поле тела `/run`, попавшее в `opts` при
сборке в `agent src/server.js:467-490`, само доезжает до `runner`. Правка: 1 строка
в `server.js` + 1 чтение в runner.

## 4. Инвентарь исходящих от шлюза (что нужно подавить)

Через `src/lib/telegram.js` (8 функций): `sendMessage:116` (и `sendMessageWithKeyboard:158`
внутри зовёт её), `editMessage:133`, `editMessageReplyMarkup:149`, `sendDocument:203`,
`pinChatMessage:175`, `unpinChatMessage:186`, `deleteMessage:194`, `answerCallbackQuery:167`.

**Мимо `telegram.js` (обойти гейт легко — обязательно в инвентарь):**
- `src/run-outbox.js:96 notify` — свой `fetch` на `sendMessage`/`editMessageText`
  (это сообщения «⚠️ сервер недоступен» / «задача отклонена»).
- `src/handlers/commands.js:699,709` — `deleteMessages`/`deleteMessage` (cleanup-flood).
- `src/lib/transient-ui.js:29` — `retireUI` (edit/delete протухших кнопок).
- `src/lib/intake-buffer.js:33` `sendTracked/sendKeyboardTracked` — НЕ экспорты, но
  внутри зовут `lib/telegram.js` (`intake-buffer.js:28`), поэтому покрываются гейтом там.

**Шва для подмены базы API у отправок нет:** `telegram.js` жёстко
`https://api.telegram.org/bot${token}` (строка 116 и далее). `TELEGRAM_API_URL`
у шлюза уважается только в **скачивании** файлов
(`handlers/message.js:553,588`, `lib/intake-files.js:35`) — не в отправке.
Read-only вызовы (`index.js:101,115,463` getWebhookInfo/getMe/getChatMemberCount)
подавлять не нужно.

## 5. Реальные ограничения (контракты, а не «так написано»)

- **C1.** Ответ агента отправляет агент (§2) → нужен агентский PR. Шлюз в одиночку задачу не решает.
- **C2.** `chatId === 0` НЕ годится как «недоставляемый чат» (слой B из `TEST-MODE.md` шага 1).
  В агенте 0 — это web/internal-sentinel: `tg-stream.js:60 hasTelegramChat` глушит
  саму отправку, **но** `gateway-callback.js:71` на 0 **не шлёт** run-finished, а
  шлюз `index.js:45` такой запрос **отвергает** (400) → `busy` в IntakeBuffer
  не отпустится до `BUSY_MAX_MS` (45 мин). Плюс теряется сам ответ агента.
  Вывод: либо реальный chatId с подавлением на стороне агента, либо явная правка
  сентинела в трёх местах. Слой B в текущем виде нерабочий — это опровержение
  допущения шага 1, а не мелочь.
- **C3.** Подавить надо ВСЁ в этот chatId, а не только финальный ответ: прогресс-редакты,
  квитанции, «▶️ Запустить», ошибки outbox, а также MCP--side отправки агента
  (`tg_send_file`, `publish_page` → TG-ссылка, `tg_send_file` в других скилах).
  Частичное подавление = тестовый шум в живом чате, то есть фича не выполнила цель.
- **C4.** Идемпотентность записи в журнал — по `requestId`: он уже есть и на
  `/run`-body (`agent-client.js:runTask`, `requestId ||= msg-<chatId>-<msgId>`),
  и в run-finished, и матчится в DO (`_busyRequestIds`). Повтор доставки не плодит запись.
- **C5.** Мультибот: 4 окружения в `wrangler.toml` (main/staging/recruiter/freelance).
  Флаг уровня env → для рекрутерского бота нужен ОТДЕЛЬНЫЙ тестовый чат, иначе режим
  неявно включится там. `SESSION_NAMESPACE`/`resolveAudience` (`lib/audience.js`)
  не помогает — это разрез по ботам, а не по чату.
- **C6.** Staging-гейт: per-PR стейджинг создаётся с нуля, `scripts/check-staging-isolation.mjs`
  требует, чтобы staging не делил KV с продом; `ci.yml` смоуит `buildSha`+`getMe`.
  Новый env-флаг как `[vars]` (не secret) переживёт деплой без ручных шагов.
- **C7.** Issue #271 (открыт): CI-гейт детерминированный, **без LLM-судьи**. Значит
  тесты режима обязаны быть чисто-функциональными (никакого живого агента в CI) —
  юнит на гейт + детерминированный прогон маршрута.
- **C8.** Прецедент-ловушка: `TEST_MODE=1` уже есть в `agent src/mainstream-tester/index.js:57`
  как env изолированного тест-агента. Это НЕ продуктовый флаг агента и не должен
  им переиспользоваться (иначе включится не там) — но сам паттерн «изолированный
  data-dir + фейковый TG» годен для тестов.

## 6. Что переиспользуем (не писать заново)

| # | Что | Где | Зачем |
|---|---|---|---|
| R1 | `POST /internal/run-finished` + Bearer + валидация | `tg-bot src/index.js:36-59` | транспорт текста ответа новым полем |
| R2 | `notifyRunFinished` / `_finishAcceptedChatRun` | `agent gateway-callback.js:64`, `runner/index.js:614` | единственная точка «ран урегулирован», уже несёт outcome/requestId |
| R3 | `taskDelivery` `{...opts}` | `agent bot-delivery.js:21` | флаг из тела `/run` доезжает сам |
| R4 | `hasTelegramChat` | `agent tg-stream.js:60` | готовая развилка «доставлять или нет» |
| R5 | `FakeTelegram` (debounce 12 c → эвент `message_final`) | `agent src/mainstream-tester/fake-telegram.js` | готовый «журнал ответов агента» для автотестов |
| R6 | `recordSent`/`sendTracked` + `_busyRequestIds` | `tg-bot intake-buffer.js:33`, `:1095` | трассировка отправок и матчинг по requestId |
| R7 | `ADMIN_GROUP_ID` + `isAdminOnlyCommand` | `tg-bot src/lib/admin-group.js` | admin-only `/test_mode on/off/status` без новой системы прав |
| R8 | `console.log` + `[observability] enabled` (wrangler.toml:11-13) | Persistent Workers Logs, ~3 дня | журнал без KV; `wrangler tail` |

## 7. Что НЕ нашёл (проверено, пусто)

- Issues/PR tg-bot про тестовый режим, dry-run, глушение ответов: **нет** (18 совпадений
  по запросу — все про другое: CI, staging-бот #94, стратегия тестов #1, баги интейка).
- `docs/requirements-log.md`: про подавление отправок/тестовый режим — **нет**.
- Единой точки исходящих в шлюзе, кроме `src/lib/telegram.js`, **нет** — 4 обхода (§4).

## 8. Открытые вопросы (не блокируют; рекомендация в скобках)

1. **Где живёт журнал:** только Workers Logs (`console.log`, `wrangler tail`) или ещё
   и в KV/DO с `/debug`-эндпоинтом? — (рекомендую: **сначала только лог**; он уже
   бесплатный, с 3-дневным TTL и не требует новой схемы хранения. Эндпоинт — если
   окажется, что `wrangler tail` неудобен для автотеста).
2. **Ключ режима:** env-список чатов (`TEST_CHAT_IDS`) или флаг в KV-сессии, чтобы
   включать/выключать без деплоя? — (рекомендую: **env-список + admin-команда поверх**;
   KV-флаг даёт запись состояния, которую придётся мигрировать).
3. **Слой B:** чинить сентинел `chatId 0` в трёх местах (C2) или отказаться от идеи
   «недоставляемый чат» и подавлять в агенте по флагу? — (рекомендую: **подавление
   в агенте по флагу `delivery:'log'`**, а слой B оставить как чистую страховку
   «если агент старый — чат недостижим», но реализовать его отдельным изменением
   с явно описанными правками сентинела, а не как сейчас «chatId 0 = тишина»).
4. **Периметр:** подавляем только когда `runTask` уже ушёл с флагом, или весь чат
   молчит с момента входа (включая `/login` подсказку)? — (рекомендую: **весь чат**,
   иначе первый же ответ «Вы вошли» покажет, что режим включён, и автотест не сможет
   отличить «работает» от «половина работает»).
