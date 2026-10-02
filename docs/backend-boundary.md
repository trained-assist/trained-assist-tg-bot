# Граница backend: один адрес (#302, #326)

Контракт шлюза `trained-assist-tg-bot` с агентом. Решение владельца
02.10.2026 (голосовое, зафиксировано в #326): **боту не нужно знать, где
ранится** — выбор машины (opencode можно на РФ-слоте, Codex/Claude нельзя)
живёт в инфраструктуре/ядре, а не в шлюзе.

## Адрес

У шлюза **один** backend — `AGENT_URL`. Все операции (запуск, стоп, статус,
файлы, проекты, сессии, быстрый ответ, input рана) идут на него. Агент сам
решает, где выполнять задачу: RU-IP-сервисы (Налог.ру, ЕСИА) обслуживает
ru-edge внутри агента (#1288) — бот в этом процессе не участвует.

Секрет `AGENT_RU_URL` в воркере больше не читается кодом (может остаться
определённым в Cloudflare до ручной чистки — на поведение не влияет).
Факт до удаления: `POST /run` на все известные RU-адреса отдавал 404
(раннера нет, `alesa-agent.service` выключен с 30.08) — фича была мёртвой,
удаление не регрессирует живое (#302).

## Гард

`tests/backend-call-map.test.js` содержит запретительный тест: любая ссылка
на `AGENT_RU_URL` / `pickAgentUrl` / `RU_ONLY_SERVICES` / `forceRu` /
`getCapabilities` / `/capabilities` в `src/**` роняет CI. Обхода карты вызовов
(новый прямой fetch к агенту вне `src/lib/agent-client.js`) тоже нет — он
описан там же.

## Карта (все адреса — `AGENT_URL`)

| Операция | Endpoint | Код |
|---|---|---|
| Подача задачи | `POST /run` | `lib/agent-client.js` `runTask` |
| Быстрый ответ | `POST /intake-quick` | `intake-preflight.js` |
| Стоп | `POST /tasks/stop` | `lib/agent-client.js` `stopTask` |
| Busy-пол | `GET /tasks/running` | `intake-buffer.js` `_pollRunFinishedIfIdle` |
| Файлы: загрузка/копия/release | `PUT /intake-files`, `POST /intake-files/release` | `lib/intake-files.js` |
| Input рана | `GET /internal/run-input` | `lib/agent-client.js` `fetchRunInput` |
| Проекты | `GET /projects`, `/project-decision` | `lib/agent-client.js` |
| Профильные/admin | `/sessions`, `/classify`, `/intake-gate`, `/tokens`, `/skills`, `/report`, `/health`, `/files`, `/files/read`, `/stats`, `/cleanup-flood`, `/maintenance`, `/internal/orphan-checklists/action`, `/capabilities`-нет | `lib/agent-client.js`, `handlers/*` |

## История

- #326 (PR #335, 02.10): переходный фанаут стоп/busy на все адреса — снят этим
  же решением, когда маршрутность удалена из бота (#302).
- Удалённые символы: `pickAgentUrl`, `RU_ONLY_SERVICES`, `getCapabilities`,
  `forceRu`, команда `/ru`, ветка `AGENT_RU_URL` в `getProjects` и
  `fetchRunInput`, список допустимых адресов в `run-outbox`.
