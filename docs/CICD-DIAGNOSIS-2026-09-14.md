# tg-bot CI/CD — диагноз и план (2026-09-14)

## Корень (подтверждён дословно)
GitHub Actions аннотация последнего прогона на `main`:
> "The job was not started because recent account payments have failed or your
> spending limit needs to be increased. Please check the 'Billing & plans' section."

- Каждый прогон (`main` и все ветки) = `failure` за ~2 сек, **ноль шагов**, логов нет
  (`BlobNotFound` — ничего не запускалось). Это не провал тестов — раннер не стартует.
- Это точнее прежней записи памяти «раннер падает за 1 сек». Причина конкретна: **биллинг**.

## Что из этого следует (вся цепочка блокировок — одна причина)
1. `auto-merge.yml` включает GitHub native auto-merge (squash) → тот ждёт зелёный CI →
   CI физически не стартует → **все 9 PR висят вечно**.
2. `deploy` job (main→wrangler) не запускается → **бот деплоится только руками** (wrangler с VM).
3. `deploy-staging` + `smoke-test-staging` + `smoke-test` — тоже никогда не запускались.
   Красивый ci.yml (CI → staging-deploy → smoke → prod-deploy → smoke) корректен, но **мёртв**.

## Состояние кода (то, что CI не проверял — проверено локально)
- `npm run check` — OK.
- `npx vitest run` — **109/110**. Единственный красный: `intake-conversation C6`
  («follow-up подтверждать, не авто-запускать») — это TDD-красный для незакрытой фичи, не регресс.
- Вывод: код по сути зелёный; всё висит из-за биллинга, не из-за кода.

### Дыра в `check` (мелкая, чинится)
`npm run check` не включает `src/index.js` импортируемые: `group-routing.js`,
`intake-buffer.js`, `intake-routing.js`. Синтакс-ошибка в них пройдёт гейт. → расширить список.

## Контракт «взял→передал→вернул→обработал недоставку» (юзер: это главное)
Состояние — крепкое, покрыто тестами:
- `agent-client.runTask`: 3 ретрая с backoff на 502/503, таймаут 15с, throw на прочем.
- `classifyAgentError`: 502/503→down; timeout→пробует `/health` (busy vs down); иначе error.
- `message.js` catch: юзеру «занят, стоит в очереди, не пересылай» / «недоступен» / «ошибка: …» —
  явная защита от повторной отправки (=дублей сессий). Тесты: agent-error-classify (5), agent-client.
- Кнопки/конверт (send-vs-edit + callback_data) покрыты рекордером в intake-тестах.

## Развилка CI/CD (реальный выбор с ценой — вынесено юзеру)
- **A) Оплатить GitHub.** Поднять spending limit / починить платёж в Billing. Тогда существующий
  ci.yml + auto-merge + staging + smoke оживают КАК ЕСТЬ, кода писать 0. Минус: постоянные $ за
  Actions-минуты private-репо + зависит от действия юзера в биллинге.
- **B) Перенести CI/CD на VM (рекомендация).** Бот — CF Worker, и так деплоим `wrangler` с VM.
  Гейт (`npm run check` + `vitest`) + merge (API squash) + `wrangler deploy` гоняются с VM,
  минуя биллинг. Ложится на текущую архитектуру (agent=systemd на VM, шлюз деплоится wrangler с VM).
  Ноль постоянных GitHub-costs, строю сейчас, обратимо. A можно добавить позже для PR-checks в UI.

## Бэклог 9 PR — не «9 фич под мерж», а триаж
- #70 project-picker: `mergeable=True`, статус `unstable` (=мешает только мёртвый CI). Кандидат №1.
- #50 (stale+automerge doc), #43 (stop-button), #42 (report-command) — по памяти уже перекрыты тем,
  что на main другими путями → проверить diff vs main, скорее **закрыть как superseded**, не мержить.
- #68 auth-follows-tguser — по памяти РЕВЕРС owner'ом (модель = per-chat), кандидат на close.
- #59 intake-gate — draft, ШАГ 1; не трогать.
- #57 get_webpass, #51 vdumchivee, #18 pinned-message — оценить гейтом B, влить если зелёные+актуальны.
- Правило: каждый PR прогнать гейтом B локально; зелёный+актуальный → merge+deploy; устаревший → close с комментом-ссылкой (durable-запись).

## Следующий шаг (обратимый, строю без ожидания биллинга)
`scripts/ci-local.sh` — VM-гейт: для PR/ветки fetch→check→vitest→(если зелёно и mergeable)
squash-merge через API→`wrangler deploy`. По умолчанию dry-run. Мерж/деплой в прод = с "go" юзера.
