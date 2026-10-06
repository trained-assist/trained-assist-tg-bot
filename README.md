# trained-assist-tg-bot

Telegram gateway Trained Assist на Cloudflare Worker. Отвечает за webhook, identity/audience, буферизацию текста и медиа, durable intake, команды/формы и доставку в исходный чат/тред. Не владеет agent runtime или бизнес-логикой доменных инструментов.

Документы содержат действующие требования, контракты и инструкции. Планы выполнения, статусы, ревью прошлых версий и evidence ведутся в GitHub issues/PR/Project. Целевая модель не является утверждением о текущем deployment; его готовность проверяется по конкретным SHA и приёмке.

## Контракт поведения

- Сохранять requestId, principal/profile, bot, chat/thread и destination до передачи задачи. Квитанция приёма не означает запуска/завершения.
- Durable Objects/KV используются согласно конкретному owner/storage contract; память Worker не является единственным источником состояния.
- Простые команды, registered forms и choices выполняются host handler без обязательного Agent Run. Отправка credentials не превращается в generic задачу.
- Один ответ принадлежит одному delivery owner. Unknown send не повторяется вслепую; receipt и terminal delivery имеют разные IDs.
- Буфер/медиа/дополнения не теряются при retry, stop и смене процесса. Parallel launch — явный выбор, а не снятие session ownership.
- Region/engine policy проверяется host/CP; GCP fail-open отсутствует в целевой модели.

## Код и локальные контракты

`src/index.js` — основной вход; `src/handlers/` — сообщения/команды/callbacks; `src/lib/agent-client.js` — совместимый backend adapter; `src/sandbox-tg/` — изолированная CP композиция. Наличие обоих путей не означает автоматического cutover; используемый binding выбирается доверенной конфигурацией.

[Backend boundary](docs/backend-boundary.md), [batch input](docs/BATCH-INPUT.md), [media](docs/MEDIA-R2.md), [scenario matrix](docs/INTAKE-SCENARIO-MATRIX.md), [test mode](docs/test-mode/DESIGN.md) — локальные источники правил.

## Изолированная проверка

### Isolated Telegram sandbox (P11)

Sandbox outgoing delivery now requires the [SQLite delivery owner and explicit
cutover manifest](docs/sandbox-delivery-owner-v1.md). Enqueue/drain/read use strong
owner storage, not KV. Ambiguous sends remain unknown without retry; legacy
deliveries quarantine. Delivery and cron start paused pending operator review.

`wrangler.sandbox-tg.toml` selects `src/sandbox-tg/index.js` and a separate
`TG_SLICE` KV namespace. Configure the required `TG_SANDBOX_BOT_TOKEN`,
`TG_SANDBOX_BOT_USERNAME`, control-plane URL/principal/profile, and chat allowlist.
The sandbox refuses production bot usernames and never falls back to `BOT_TOKEN`.
Set `TELEGRAM_WEBHOOK_SECRET` and register the same value as Telegram's
`setWebhook.secret_token`. Missing, empty, or mismatched webhook secrets return
401; `/health` remains accessible without webhook or delivery credentials.
The HTTP `/cron` route requires the same secret. Scheduled events build their
own controller from bindings.

Provision `CONTROL_PLANE_PRINCIPAL_SIGNATURE` with
`wrangler secret put CONTROL_PLANE_PRINCIPAL_SIGNATURE --config wrangler.sandbox-tg.toml`.
This optional binding is a precomputed hex HMAC-SHA256 signature of the exact
`CONTROL_PLANE_PRINCIPAL`, using the control plane's principal secret. Provision
it through a trusted operator; keep the root signing secret out of the gateway.
The client sends the signature as `x-principal-sig`. Unsigned local fake-control-plane
fixtures remain supported; a deployed control plane requires its configured auth.

Reconciliation scans paginated KV keys, reads their values, and delivers stored
receipts separately from terminal results. Direct and launched-batch indexes persist
the original chat, thread, and requesting bot. Final replies use `result.answer`
(or a string result), with explicit notices for failure, cancellation, unknown
execution, or absent answer text. Old indexes without a destination are skipped
rather than guessing a Telegram chat from a profile ID. Existing legacy
`delivery:<userTaskId>` records still drain; new receipt and terminal IDs do not
overwrite them. Retry attempts and dead records survive repeated reconciliation.

Run the regression fixtures with `npx vitest run tests/p11*.test.js`.
They exercise the exported HTTP and scheduled handlers against a Telegram emulator
and fake control plane with the Cloudflare KV listing shape. They do not prove live
Telegram delivery, concurrent ingress safety, or cloud deployment readiness.

```bash
npm ci
npm run check
npm test
npm run dev
```

Deployment/webhook изменяет только владелец соответствующего контура. Credentials задаются bindings/secrets; токены не появляются в URL, issue или test output.

## Совместная разработка

Ветка и PR обязательны; проверяйте `.githooks/` через `scripts/install-git-hooks.sh`. Открытые PR не изменяются чужой сессией. Status/evidence — в [Integrator #140](https://github.com/trained-assist/trained-agent-architecture/issues/140) и issue задачи; общий контракт — [архитектура](https://github.com/trained-assist/trained-agent-architecture/blob/main/ARCHITECTURE.md).

Retiring GCP VM is not a development or fallback target. Use the own Agent Run API and serverless by default; a necessary persistent service belongs on the existing French VM. Other Google services remain allowed. Exit coordination: https://github.com/trained-assist/trained-agent-architecture/issues/145.
