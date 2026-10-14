# SELF-TEST-ENV — Инвентаризация self-test эндпоинтов

**Дата:** 2026-10-13
**Роль:** worker (S1)
**Статус:** baseline probe выполнен; таблица актуальна на момент замера.

## 1. Обзор воркеров

| Worker | wrangler name | URL | main entry |
|---|---|---|---|
| tg-bot production | `trained-assist-tg-bot` | `https://trained-assist-tg-bot.skillset-apply.workers.dev` | `src/index.js` |
| tg-bot freelance | `trained-assist-tg-bot` (custom domain) | `https://tg-freelance.trainedassist.store` | `src/index.js` |
| tg-bot sandbox | `trained-assist-tg-sandbox` | `https://trained-assist-tg-sandbox.skillset-apply.workers.dev` | `src/sandbox-tg/index.js` |
| tg-bot sandbox3 | `trained-assist-tg-sandbox3` | `https://trained-assist-tg-sandbox3.skillset-apply.workers.dev` | `src/sandbox-tg/existing-ux.js` |
| CP production | `trained-assist-cp-production` | `https://trained-assist-cp-production.skillset-apply.workers.dev` | `src/index.ts` |
| CP sandbox3 | `trained-assist-cp-sandbox3` | `https://trained-assist-cp-sandbox3.skillset-apply.workers.dev` | `src/index.ts` |
| Runner sandbox3 | `trained-assist-runner-api-sandbox3` | `https://trained-assist-runner-api-sandbox3.skillset-apply.workers.dev` | `src/cloudflare/index.ts` |
| Runner cp-sandbox3 | `trained-assist-runner-api-cp-sandbox3` | `https://trained-assist-runner-api-cp-sandbox3.skillset-apply.workers.dev` | `src/cloudflare/index.ts` |
| Runner telegram-ux-v1 | `trained-assist-runner-api-telegram-ux-v1-sandbox` | `https://trained-assist-runner-api-telegram-ux-v1-sandbox.skillset-apply.workers.dev` | `src/cloudflare/index.ts` |

## 2. Health-эндпоинты (проверено probe'ом 2026-10-13)

| Worker | Endpoint | Статус | Примечание |
|---|---|---|---|
| tg-bot production | `GET /health` | 200 | `buildSha: e84e24e4…`, executionBackend=control-plane |
| tg-bot freelance | `GET /health` | 200 | `buildSha: e84e24e4…`, executionBackend=legacy-agent |
| tg-bot sandbox | `GET /health` | 200 | bot=probability_cat_bot, mode=direct |
| tg-bot sandbox3 | `GET /health` | 200 | mode=existing-ux-control-plane |
| CP production | `GET /healthz` | 200 | `buildSha: dbef4062…` |
| CP sandbox3 | `GET /healthz` | 200 | `buildSha: d98af9ae…` |
| Runner sandbox3 | `GET /healthz` | 200 | executionWorker=eu-vm-agent-run |
| Runner cp-sandbox3 | `GET /healthz` | 200 | executionWorker=eu-vm-agent-run |
| Runner telegram-ux-v1 | `GET /healthz` | 200 | executionWorker=eu-vm-agent-run |

## 3. Operator / self-test эндпоинты (tg-bot)

### 3.1 sandbox3 (`trained-assist-tg-sandbox3`) — полный набор

Все эндпоинты требуют `Authorization: Bearer <TG_SANDBOX3_OPERATOR_TOKEN>`.
Источник токена и рабочий канал — §11 (runbook S4).

| Endpoint | Метод | Probe (без токена) | Описание |
|---|---|---|---|
| `/operator/test-evidence` | GET | 401 | Корреляция CP acceptance → task store → delivery. Возвращает tasks[], buffer state. |
| `/operator/test-delivery/:taskId` | GET | 401 | Read-only чтение delivery receipt + terminal + artifacts по taskId. |
| `/operator/test-update` | POST | exists (404 на GET probe) | Отправка Telegram-shaped message/callback в webhook. Возвращает bot replies как JSON. |
| `/operator/test-buffer-message` | POST | exists (404 на GET probe) | Буферизация сообщения в intake. |
| `/operator/delivery-cutover` | GET | — | Состояние delivery cutover. |
| `/operator/delivery-cutover-v1` | GET | — | Состояние delivery cutover v1. |
| `/operator/stop-window` | POST | — | Остановка окна intake. |
| `/operator/reset-sandbox-state` | POST | — | Сброс sandbox state. |
| `/collector-state` | GET | — | Состояние collector'а. |

**Пинned test chat:** `TG_SANDBOX_E2E_CHAT_ID = "1714048"`, `TG_SANDBOX_E2E_USER_ID = "1714048"`.

### 3.2 sandbox (`trained-assist-tg-sandbox`) — минимальный

| Endpoint | Метод | Probe | Описание |
|---|---|---|---|
| `/operator/test-evidence` | GET | 401 `{"error":"unsigned update refused"}` | Существует, но требует подпись (не Bearer token). |
| `/operator/test-delivery/:taskId` | GET | 401 `{"error":"unsigned update refused"}` | Аналогично. |

**Примечание:** локальный код `src/sandbox-tg/index.js` не содержит этих роутов — 401 приходит из задеплоенной версии, которая отличается от локального checkout. Расхождение фиксируется как находка.

### 3.3 production (`trained-assist-tg-bot`) — operator-эндпоинтов НЕТ

| Endpoint | Метод | Probe | Описание |
|---|---|---|---|
| `/operator/test-evidence` | GET | 404 | Не задеплоено в production worker. |
| `/operator/test-delivery/:taskId` | GET | 404 | Не задеплоено. |

Production worker (`src/index.js`) имеет только: `/health`, `/webhook`, `/webhook/:botId`, `/deliver`, `/internal/*`, `/debug/*`.

## 4. CP internal эндпоинты

### 4.1 CP production и sandbox3 (одинаковый код)

| Endpoint | Метод | Описание |
|---|---|---|
| `/healthz` | GET | Liveness. |
| `/health` | GET | Health с деталями. |
| `/internal/runner/profile-health` | GET | Проверка здоровья Runner. |
| `/internal/sandbox/runner-mock-probe` | GET | Mock probe для sandbox. |
| `/internal/sandbox/readiness` | GET | Readiness для sandbox. |
| `/internal/health/catalogue` | GET | Каталог здоровья сервисов. |
| `/internal/health/summary` | GET | Сводка здоровья. |

**Probe:** `/healthz` → 200 на обоих средах. Остальные internal эндпоинты не probe'ились (требуют auth или специфичные параметры).

## 5. Runner API эндпоинты

### 5.1 Общий контракт (все 3 runner-воркера)

| Endpoint | Метод | Auth | Описание |
|---|---|---|---|
| `/healthz` | GET | Нет | Liveness. |
| `/healthz/workers` | GET | Нет | Здоровье внешних воркеров (GHA и др.). |
| `/v1/capabilities` | GET | Bearer | Возможности API. |
| `/v1/runs` | POST | Bearer | Создание ранна. |
| `/v1/runs/:runId/status` | GET | Bearer | Статус ранна. |
| `/v1/runs/:runId/result` | GET | Bearer | Результат ранна. |
| `/v1/runs/:runId/artifacts` | GET | Bearer | Артефакты ранна. |
| `/v1/runs/:runId/events` | GET | Bearer | События ранна (SSE). |
| `/v1/runs/:runId/log` | GET | Bearer | Лог ранна (302 redirect). |
| `/v1/runs/:runId/cancel` | POST | Bearer | Отмена ранна. |
| `/v1/profiles/workspace` | POST | Bearer | Provisioning workspace. |
| `/v1/worker/launches/:runId/profile-changes` | POST | Bearer | Upload profile changes. |

**Probe:** `/healthz` → 200 на всех 3 воркерах. Остальные требуют Bearer API key.

## 6. Password / login пути (Telegram-команды, не HTTP)

| Команда | Описание | Где |
|---|---|---|
| `/pass_reset username` | Генерация тестового пароля + команда входа. | `src/handlers/user-mgmt.js` |
| `/login username password` | Вход в sandbox. | `src/handlers/user-mgmt.js` |

**Примечание:** это Telegram bot commands, а не HTTP endpoints. Sandbox E2E использует отдельного тестового пользователя sandbox-бота. Production E2E проводится через настоящий production Worker и существующий тестовый аккаунт.

## 7. Test chat 1714048

| Среда | Конфигурация | Статус |
|---|---|---|
| sandbox3 | `TG_SANDBOX_E2E_CHAT_ID` / `TG_SANDBOX_E2E_USER_ID` задаются секретами workflow | Отдельный sandbox bot + sandbox CP; pinned только внутри sandbox. |
| production | Существующий приватный тестовый чат/user `1714048` | Реальный production bot + обычный `gateway` principal и `trained-assist-production` profile. Запуск: `Production Telegram test account E2E` из `main`. |

## 8. Сводная матрица: среда × эндпоинт × статус

| Эндпоинт | sandbox3 | sandbox | production |
|---|---|---|---|
| `/health` / `/healthz` | 200 | 200 | 200 |
| `/operator/test-evidence` | 401 (exists) | 401 (exists) | 404 |
| `/operator/test-delivery/:taskId` | 401 (exists) | 401 (exists) | 404 |
| `/operator/test-update` | exists (POST) | — | 404 |
| `/operator/test-buffer-message` | exists (POST) | — | 404 |
| `/internal/health/*` | exists | — | exists |
| `/v1/runs/*` (Runner) | 200 (healthz) | — | — |

## 9. Ключевые находки

1. **Production не имеет operator-эндпоинтов.** Для E2E на production-лане используется только allowlist 1714048 + обычный Telegram flow. Self-test через HTTP на production невозможен.
2. **sandbox3 — единственная среда с полным набором operator-эндпоинтов.** Все требуют `TG_SANDBOX3_OPERATOR_TOKEN`.
3. **sandbox (probability_cat_bot) имеет расхождение код↔деплой.** Локальный код не содержит operator-роутов, но задеплоенная версия отвечает 401.
4. **Runner API не имеет выделенных self-test эндпоинтов.** Тестирование через `/v1/runs` (создание ранна) + `/healthz/workers`.
5. **CP internal эндпоинты** существуют в коде, но не probe'ились в этой сессии (требуют auth/параметры).

## 10. Production E2E

Production не имеет operator/self-test endpoints. Тест проходит через обычный production Worker, bot `@super_personal_assistant_bot` и существующий приватный тестовый аккаунт `1714048`. Protected workflow `Production Telegram test account E2E` проверяет identity, build SHA, включённый ingress/delivery и пустое состояние Intake перед двумя сообщениями, затем сохраняет redacted evidence. Никогда не направлять sandbox bot/Worker в production CP.

## 11. Runbook: источник `TG_SANDBOX3_OPERATOR_TOKEN` (S4)

**Факт (probe 2026-10-13):** локальная keychain-копия токена устарела —
`curl -H "Authorization: Bearer <keychain token>" …/operator/test-evidence`
на sandbox3 возвращает **401** (как и запрос без токена). Значения ключа
здесь не приводятся (R9).

| Канал | Источник значения | Статус |
|---|---|---|
| **CI-dispatch (рабочий)** | GitHub Actions **repo secret** `TG_SANDBOX3_OPERATOR_TOKEN` (`trained-assist/trained-assist-tg-bot`, updatedAt 2026-10-10); workflow подставляет его в Worker через `wrangler secret put TG_SANDBOX3_OPERATOR_TOKEN --config wrangler.sandbox-tg-sandbox3.toml` | ✅ единственный проверенный канал (E2E-REPORTS: прогоны 38348837920, 38349472846, 38358741038, 38359301343 — все PASS) |
| Keychain `trained-assist-tg-bot-sandbox` (acct `sandbox-cleanup`) | локальная копия в login keychain | ❌ устарела: 401 |
| GitHub API (`gh secret`) | — | ❌ значения не отдаёт API |

**Как выполнить локальный/self-test прогон (рабочий путь):**

1. Диспатч защищённого CI-харнесса с protected main:
   `gh workflow run sandbox3-worker-e2e.yml -R trained-assist/trained-assist-tg-bot`
   (workflow `Sandbox3 Telegram worker E2E`, `workflow_dispatch`; опции сценария
   см. в `.github/workflows/sandbox3-worker-e2e.yml`).
2. Workflow сам: выкатывает sandbox3, ставит оператор-секреты, прогоняет
   сценарий test-update → Intake → CP → Runner → Telegram и сохраняет
   evidence JSON. Локальный токен не нужен.
3. Прямые HTTP-вызовы `/operator/*` с локальной машины **невозможны**, пока
   keychain-копия не ротирована (ротация — E1: runbook кредов; не плодить
   параллельных источников).

**Правила:** значения секретов нигде не записываются (R9); найденный сбой
самой среды — блокер, чинится первым (BACKLOG S4).
