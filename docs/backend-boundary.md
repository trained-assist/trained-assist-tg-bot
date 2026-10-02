# Граница backend: операция → адресат (#326)

Контракт шлюза `trained-assist-tg-bot` с агентом. Фиксирует, **куда** уходит каждая
операция, чтобы выбор исполнителя (RU/EU) не создавал асимметрию. Проверяется
`tests/backend-call-map.test.js` — новый прямой вызов к агенту вне этой карты
роняет CI.

## Адреса

Агент — **один логический backend** с двумя развёртываниями:

- `AGENT_URL` — основной VM;
- `AGENT_RU_URL` — региональный VM (сервисы, работающие только с российского IP:
  ФНС/налог, госуслуги). Может отсутствовать.

Подача задачи (`POST /run`) выбирает VM по `pickAgentUrl`: явный `/ru` + `forceRu`
или авто-по ключевым словам при наличии у профиля RU-только токена. Больше нигде
адресат не вычисляется.

## Правило

**Chat-scoped операции фанаутятся на все настроенные backend'ы** (`agentBases(env)`),
потому что шлюз не хранит маршрут конкретной задачи: задача могла уйти на RU VM, а
стоп/статус обязаны найти её там. Операция при этом скоупится по
`audience + chatId (+ threadId)`, поэтому backend без такой задачи просто отвечает
`0`/`running:false` — вреда нет.

Когда RU-маршрутизация будет снята (#302 / вариант B), `agentBases` вырождается в
один адрес, и фанаут исчезает сам — интерфейс адаптера не меняется.

## Карта

| Операция | Endpoint | Адресат | Код |
|---|---|---|---|
| Подача задачи | `POST /run` | `pickAgentUrl` (может быть RU) | `lib/agent-client.js` `runTask` |
| Быстрый ответ | `POST /intake-quick` | `pickAgentUrl` (может быть RU) | `intake-preflight.js` |
| **Стоп** | `POST /tasks/stop` | **все backend'ы** (`agentBases`), `killed` суммируется | `lib/agent-client.js` `stopTask` |
| **Busy-пол** | `GET /tasks/running` | **все backend'ы**; busy, если хоть один `running` | `intake-buffer.js` `_pollRunFinishedIfIdle` |
| Файлы: загрузка | `PUT /intake-files` | `AGENT_URL` (на входе маршрут ещё неизвестен) | `lib/intake-files.js` |
| Файлы: копия на VM рана | `PUT /intake-files` | адрес рана (`copyRefsToAgent`) | `lib/intake-files.js` |
| Файлы: снятие pin | `POST /intake-files/release` | основной + адрес рана | `lib/intake-files.js` `releaseBufferPins` |
| Input рана | `GET /internal/run-input` | `pickAgentUrl` + фолбэк на оба | `lib/agent-client.js` `fetchRunInput` |
| Профильные/admin | `/projects`, `/sessions`, `/classify`, `/intake-gate`, `/tokens`, `/skills`, `/report`, `/health`, `/files`, `/files/read`, `/stats`, `/cleanup-flood`, `/maintenance`, `/internal/orphan-checklists/action` | `AGENT_URL` | `lib/agent-client.js`, `handlers/*` |

Профильные данные (сессии/проекты/токены) живут на основном VM; RU VM —
только исполнение RU-задач. Перенос профильного состояния в общую модель —
отдельная работа (C04, placement).

## Открытый вопрос

Вариант **B** — снять авто-маршрутизацию по ключевым словам (#302), оставив явный
`/ru` как ручной override. Это продуктовое решение владельца; при его принятии
`pickAgentUrl`/`RU_ONLY_SERVICES` удаляются, карта выше сжимается до `AGENT_URL`.
Текущий код — вариант **A** (адресат операции определён явно, фанаутом).
