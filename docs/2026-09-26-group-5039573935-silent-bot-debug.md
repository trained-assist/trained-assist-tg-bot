# Разбор: «бот не отвечает» в чате `5039573935` (группа `-5039573935`)

Дата: 2026-09-26. Автор: debug-сессия (opencode).
Статус: **симптом пропал после живого теста; корневая причина не подтверждена на 100%** — ниже факты, хронология, подозреваемые и регламент на будущее.

## 1. Что это за чат

- Телеграм-группа **`-5039573935`**, title: «ci-cd. Vladimir & Super Assistant powered y Claude AI», тип `group` (не супергруппа, не форум), **2 участника** — бот + Вова.
- Бот: `@super_personal_assistant_bot` (id `8843910332`), воркер `trained-assist-tg-bot`.
- Профиль агента (пользователь): `trained-assist-product-owner` (многочатовый профиль: тот же profile используют и чаты `-5578467476`, `-1004371070440`, `-5501536471`).
- Состояние сессии в KV: `allMsgMode: true` → группа в режиме «все сообщения копим в intake».

> Обрати внимание: пользователь спросил про `5039573935` (положительный), а реальный id группы — `-5039573935`. `getChat` для положительного id даёт «chat not found»; для отрицательного — всё корректно. Всегда проверяй оба знака.

## 2. Факты из проверки (что является, а что нет причиной)

Проверено на живом проде (Mac + GCP VM `vova@136.65.7.197`).

**НЕ проблема:**
- Вебхук Telegram настроен верно: `getWebhookInfo` → URL `https://trained-assist-tg-bot.skillset-apply.workers.dev/webhook`, `pending_update_count = 0`, `last_error_message` отсутствует. Т.е. Telegram апдейты доставляет и воркер их принимает (200).
- Бот живой: `getMe` ок, `can_read_all_group_messages: true` (privacy mode выключен на уровне BotFather — в группе видит все сообщения).
- Сервис агента активен: `systemctl is-active assist-agent = active` (рестарт 12:49 UTC).
- Воркер точно **получает** сообщения этой группы: в KV-сессии группы `lastMessageAt` обновлялся (16:44:45 МСК — «пропавшее» сообщение; 17:16:54 МСК — тестовое «пишу»), и в live-tail видно `[group -5039573935] kobzevvv: <текст>` + `ambient memberCount=... allMsgMode=true`.

**Аномалия (собственно симптом):**
- В 16:44:45 МСК сообщение в группу пришло, KV-сессия обновилась (`lastMessageAt`), но:
  - в логах агента по этому чату после 15:21 МСК — **ничего**;
  - intake-буфер пуст, `busy=false`, зависших батчей нет;
  - ботом ничего не отправлено (последний id в KV `sent:-5039573935` был `12713`).
- То есть «глохло» между «воркер принял апдейт» и «показал ack / запустил задачу».

**Живой тест 17:16 МСК — всё прошло:**
1. `POST /webhook` (сообщение «пишу», 394 байта) → лог `[group -5039573935] kobzevvv: пишу`.
2. `DO:IntakeBuffer /ingest` → 200 (сообщение принято в буфер).
3. Воркер отправил collector с кнопкой `▶️ Запустить проработку` (в KV `sent:` добавился id `12717`).
4. Второй `POST /webhook` (1750 байт — почти наверняка **нажатие ▶️**, у текста заголовок был 394) в 17:16:54.
5. `DO:IntakeBuffer /flush` → 200, `DO:RunOutbox /enqueue` → 202.
6. Агент: `[trained-assist-product-owner-tg-346166...] answer-router mode=deep (workrun)`.

Вывод: пайплайн исправен, «починилось» — минимум для ручного сценария (сообщение → ack → ▶️ → запуск).

## 3. Хронология (UTC; локально +3ч МСК)

| Время UTC | Событие |
|---|---|
| 12:21:49 | Последний прогон агента в группе `-5039573935` закрыт `done` (сессия `s-5039573935-1790421683966`, тема «продолжай»). |
| 13:44:45 | Сообщение в группу: KV-сессия обновилась, ответа/запуска нет (**симптом**). Похоже, пользователь тестировал перед обращением. |
| 14:16:00 | Тест «пишу»: webhook → intake/ingest 200. |
| 14:16:54 | Нажатие ▶️: intake/flush + RunOutbox enqueue 202. |
| 14:16:56 | Агент запустил deep-сессию. |
| ~14:17 | После живого теста — «как будто починилось». |

## 4. Подозреваемые причины (ранжировано, не подтверждено)

Intake-флоу многоступенчатый, и в группах у него есть **несколько тихих** режимов отказа — каждый из них выглядит как «бот молчит»:

1. **`msgAge > 300` — silent-drop устаревших сообщений в группах.**
   В `dispatchInner`: если `Date.now()/1000 - msg.date > 300` (апдейт доставлен позже 5 минут), сообщение отбрасывается, и уведомление шлётся **только для private** чатов; в группах — молча. Если Telegram ретраил доставку (холодный изолят, короткий сбой воркера), сообщение тихо исчезает. При этом `pending_update_count` уже мог обнулиться.
   *Это лучше всего объясняет «бот не видит многие сообщения, а некоторые видит».*

2. **`busy`-hold IntakeBuffer до 45 минут.**
   Если изолят умер прямо во время рана, `busy` не сбрасывается, и следующие сообщения только получают «⏳ Иду по текущей задаче…» и **не** авто-запускаются (`BUSY_MAX_MS = 45 * 60_000`).

3. **Регресс в свежих изменениях воркера.**
   Локальный чекаут был **позади прода**: prod = `bccfc02` (#272), локально — `4b71ea1` (#257). Между ними в один день прилетело много правок именно по группам/intake: #255/#260 (topic isolation), #262 (`chatConfigCommandFromPhrase` — фразы вроде «покажи настройки»/«закрепи X» превращаются в команду и **не** буферизуются), #263/#264/#265/#266, #267, #272 (project fallback). Любая из них могла дать тихий сайд-эффект, который уже «перекрылся» позже.

4. **Дедуп по `message_id` в DO `received`.**
   Повторная доставка того же апдейта вернёт `{duplicate:true}` и не покажет ack.

5. **Ошибки отправки/редактирования в Telegram (agent→TG `fetch failed`, worker `sendTracked` catch).**
   В логах агента видели `progress edit failed ... chat=-5039573935 msg=12670: fetch failed`. Если такие ошибки приходятся на отправку collector, пользователь видит тишину.

## 5. Что осталось выяснить

- Достать событие 13:44:45 UTC из **исторических Workers Logs** (они пишутся ~3 дня, `[observability] enabled = true`) в CF-дашборде: Dashboard → Workers & Pages → `trained-assist-tg-bot` → Logs. Это единственный способ увидеть, что именно произошло тогда (tail его не застал).
- Проверить, был ли в 13:44 апдейт «старым» (`msg.date` > 5 мин) — тогда версия №1 подтверждается.
- Проверить, не оставался ли DO `busy` в тот момент (сейчас — нет).

## 6. Регламент на будущее — как дебажить «бот молчит в чате X»

Все команды — с Mac (или сразу с VM). `AGENT_SECRET` берётся с GCP: `ssh vova@136.65.7.197 'grep "^AGENT_SECRET=" ~/secrets.env | cut -d= -f2'`.

**Шаг 0. Нормализуй id.** Для группы помни про знак: `-5039573935`, а не `5039573935`.

**Шаг 1. Проверь транспорт (Telegram ↔ воркер).**
```bash
S=$(security find-generic-password -s telegram-bot-token-super-personal-assistant -a BOT_TOKEN -w)
curl -s "https://api.telegram.org/bot$S/getWebhookInfo" | python3 -m json.tool
curl -s "https://api.telegram.org/bot$S/getChat?chat_id=-<chatId>"
curl -s "https://api.telegram.org/bot$S/getChatMemberCount?chat_id=-<chatId>"
```
Смотри `pending_update_count`, `last_error_message`, `url`.

**Шаг 2. Живой лог воркера (самое информативное).**
```bash
cd ~/Code/trained-assist-tg-bot
npx wrangler tail trained-assist-tg-bot --format=json | tee /tmp/tgbot-tail.jsonl
```
Пришли тест-сообщение в чат. В логе ищи цепочку:
`[group <id>] ...` → `DO:IntakeBuffer /ingest` → `DO:IntakeBuffer /flush` → `DO:RunOutbox /enqueue` → (агент).
Если после `[group ...]` ничего — см. подозреваемые №1–3; если есть `[group ...]` но нет `/ingest` — проблема в `routeText`/конфиг-фразах (#262).

**Шаг 3. Состояние intake-буфера (Bearer `AGENT_SECRET`).**
```bash
curl -s "https://trained-assist-tg-bot.skillset-apply.workers.dev/debug/intake/-<chatId>" \
  -H "Authorization: Bearer $AGENT_SECRET" | python3 -m json.tool
```
Смотри `buf`, `busy`, `busySince`, `retryBatch`, `failedBatches`, `debounceExpiresAt`, `gateLevel`.
- Буфер не пуст и давно `debounceExpiresAt` в прошлом → застрял авто-запуск.
- `busy: true` уже давно → подвисший ран (см. №2), лечится ожиданием ≤45 мин или `/clean_buffer`.

**Шаг 4. Восстановление/сброс.**
```bash
# вернуть batch из failed в retry (не запускает задачу сам):
curl -s -X POST ".../debug/intake/-<chatId>/restore" -H "Authorization: Bearer $AGENT_SECRET" -d '{"id":"<uuid из failedBatches>"}'
```
В самом Telegram в чате: **`/clean_buffer`** — сбросить накопленное без запуска; **`/all_on`/`/all_off`** — режим группы.

**Шаг 5. KV воркера (сессия и что бот отправлял).**
```bash
cd ~/Code/trained-assist-tg-bot
# ВНИМАНИЕ: ключ с ведущим «минусом» прокидывай через $'...'
npx wrangler kv:key get $'\-<chatId>'           --namespace-id=5753e58c86c14550930106cf9248eb72
npx wrangler kv:key get $'sent:\-<chatId>'      --namespace-id=5753e58c86c14550930106cf9248eb72
npx wrangler kv:key list --prefix="retry:"      --namespace-id=5753e58c86c14550930106cf9248eb72
```
`sent:<chat>` — список последних исходящих id бота; если там тишина после времени проблемы — бот действительно ничего не отправил.

**Шаг 6. Сторона агента (GCP).**
```bash
ssh vova@136.65.7.197
sudo journalctl -u assist-agent -f            # live
sudo journalctl -u assist-agent --since "10 min ago"   # ВАЖНО: время VM в UTC
grep -rl "^-\?<chatId>$" ~/agent-tokens/*/.chatid      # какой профиль владеет чатом
```
Историю диалога смотреть тут: `~/users/<profile>/sessions/s-<abs(chatId)>-<ts>.json`.

**Шаг 7. Исторические логи воркера.** CF Dashboard → Workers & Pages → `trained-assist-tg-bot` → **Logs** (хранятся ~3 дня). Там искать момент пропажи.

## 7. Рекомендации (что стоит поправить в коде)

1. **Убрать тихий дроп устаревших сообщений в группах** — либо уведомлять и в группах, либо хотя бы `console.warn` с `msgAge` (сейчас группа молча теряет апдейт, доставленный позже 5 минут). Кандидат №1 по влиянию.
2. **Видимый таймаут/алерт при застрявшем `busy`** — если `busySince` старше N минут, слать в чат явное сообщение, а не ждать 45 минут.
3. **Обновить локальные чекауты** репозиториев до `origin/main` перед дебагом (в этой сессии локально было `4b71ea1` при проде `bccfc02` — легко дебажить «не тот» код).
4. Рассмотреть отдельный алерт (Telegram/Grafana) на аномалию «входящих нет N минут, а чат активен».

## 8. Ссылки/артефакты

- Воркер: `https://trained-assist-tg-bot.skillset-apply.workers.dev` (health показывал `buildSha: bccfc02`).
- Агент: GCP VM `136.65.7.197`, сервис `assist-agent`.
- Профиль чата: `trained-assist-product-owner`.
- KV-неймспейс SESSIONS: `5753e58c86c14550930106cf9248eb72`.
