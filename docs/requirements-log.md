# Requirements Log — Alesa (trained-assist-tg-bot)

## Инфраструктура

- [реализовано] Cloudflare Worker (Hono) — Telegram webhook handler, stateless, без состояния
- [реализовано] GCP VM <GCP_VM_IP> — основной агент (trained-assist-agent), запускает Claude сессии через `claude --dangerously-skip-permissions`
- [реализовано] Hostland VM <RU_VM_IP> — RU IP агент (trained-assist-agent та же кодовая база), для российских гео-блокированных сервисов
  - 8GB RAM, 4 vCore, 60GB NVMe, Москва, 862₽/мес
  - HTTPS: https://<RU_VM_HOST>
  - Запускается как systemd сервис assist-agent (SECRETS_SOURCE=env)
- [реализовано] nginx + Let's Encrypt на обоих VM
- [реализовано] Per-user изоляция: ~/users/{username}/ на каждом VM

## Аутентификация и токены

- [реализовано] Chrome extension (cloud-auth-bridge) — захватывает куки и sessionStorage с сайтов
- [реализовано] Token relay (GCP VM :8081) — паринг расширения с ботом по 6-значному коду
- [реализовано] Токены хранятся в ~/agent-tokens/{username}/{label} (ключ = имя пользователя, не chatId)
- [реализовано] Миграция: при первом запуске из новой группы токены копируются из ~/agent-tokens/{chatId}/ в ~/agent-tokens/{username}/
- [реализовано] .chatid файл — runner.js записывает текущий chatId для уведомлений TG (истечение nalog и connect-форм)
- [реализовано] Форвардинг токенов на RU VM — token-relay дублирует все токены на https://<RU_VM_HOST>/tokens
- [реализовано] nalog.ru sessionStorage захват — Chrome extension читает auth.token и refresh.token через chrome.scripting.executeScript
- [реализовано] /settoken — ручное сохранение токена через Telegram команду (ключ = username)
- [реализовано] /chromeext_connect — паринг Chrome расширения через 6-значный код
- [реализовано] Connect-формы (/connect/getcourse, /connect/nalog и т.д.) — токены привязаны к username

## Маршрутизация задач

- [реализовано] /ru <задача> — явная маршрутизация задачи на RU VM (nalog.ru, госуслуги и т.п.)
- [реализовано] Auto-detect — задачи с ключевыми словами nalog, налог, госуслуги и т.п. автоматически идут на RU VM
- [реализовано] /status — показывает статус обоих агентов (GCP + RU VM)
- [реализовано] AGENT_RU_URL секрет в Cloudflare Worker

## Функциональность бота

- [реализовано] /login username password — вход пользователя
- [реализовано] /sessions / /диалоги — просмотр и выбор диалогов
- [реализовано] /new_dialog / /новый_диалог — новый диалог (чистый или с контекстом)
- [реализовано] /files / /папки — файловый браузер с inline keyboard
- [реализовано] Голосовые сообщения — транскрипция через Deepgram nova-2
- [реализовано] Streaming вывода — Claude Code output стримится в Telegram через edit message
- [реализовано] Heartbeat с tool activity — "Думаю…" обновляется каждые 12с с текущим инструментом (💻 bash, 📖 read, ✏️ edit, 🌐 fetch); tool_use события обновляют сообщение немедленно; если Claude упал с ошибкой без вывода — показывает "⚠️ Процесс завершился с ошибкой"
- [реализовано] Expired token detection — если токен Налог.ру истёк, агент сразу говорит "🔒 Токен истёк" + инструкция по обновлению; Claude не запускается зря
- [реализовано] Классификация сообщений — Haiku определяет в какой диалог добавить сообщение
- [реализовано] Дизамбигуация — инлайн клавиатура при неоднозначной маршрутизации

## Гео-блокировка

- [реализовано] nalog.ru (lknpd.nalog.ru) недоступен с GCP VM (EU) — решено через RU VM
- [отклонено] Playwright для nalog.ru на GCP VM — гео-блок, не работает
- [планируется] gosuslugi.ru, mos.ru и другие РФ-сервисы через RU VM

## Playwright / Browser automation

- [реализовано] Playwright MCP на каждом VM — per-user Chrome profiles
- [реализовано] ~/.claude/scripts/pw.sh — автодетект аккаунта по CWD

## Remote Browser Session (noVNC)

- [реализовано] Persistent Chrome on GCP VM: Xvfb :99 + Chrome (CDP :9224) + x11vnc + noVNC
  - Сервисы: xvfb-browser, wm-browser (openbox), chrome-browser, vnc-browser, novnc-browser, ntp-hider, login-server (systemd)
  - URL: https://<GCP_VM_HOST>/browser/
  - Chrome profile: ~/chrome-profiles/browser-session (сессии сохраняются)
  - CDP порт 9224 (9222 был занят другим процессом Chrome)
- [реализовано] Standalone login page (tilda-login.html):
  - /browser/ → редирект на tilda-login.html (форма логина)
  - Форма POST → /browser-login → nginx proxy → login-server.js (:9090)
  - login-server.js запускает login.js который заполняет форму в Chrome через CDP
  - После успеха → redirect на /browser/vnc.html (VNC с залогиненной сессией)
  - Поддержка CAPTCHA/2FA — redirect на VNC с сообщением пользователю
- [реализовано] ntp-hider.service — скрывает Chrome New Tab окно (polling 0.3s, wmctrl + xdotool)
  - openbox WM нужен для xdotool window management
- [реализовано] x11vnc с -xfixes — clipboard sync через X11 XFIXES
- [реализовано] browser-session MCP skill (21-browser-session.js):
  - browser_session_url — ссылка для пользователя
  - browser_session_capture_cookies — захват кук через CDP (~/browser-session/capture-cookies.js)
  - browser_session_navigate — навигация удалённого Chrome
  - browser_session_status — проверка состояния
  - browser_session_login — заполняет форму логина через CDP (env vars LOGIN_EMAIL/LOGIN_PASSWORD)
- [реализовано] Tilda skill обновлён: при session_expired → guided flow через browser session
- [планируется] Per-user display isolation (сейчас один дисплей :99 для всех пользователей)

## CI/CD

- [реализовано] GitHub Actions CI для trained-assist-tg-bot — npm ci, syntax check, vitest unit tests
- [реализовано] GitHub Actions CI для trained-assist-agent — npm ci, syntax check, 16 vitest tests (browser + session-store)
- [реализовано] deploy-gcp job: SSH → git reset --hard → deploy.sh → systemd restart assist-agent
- [реализовано] deploy-ru job: SSH password auth → git safe.directory → git reset --hard → deploy.sh
- [реализовано] Все три job (ci, deploy-gcp, deploy-ru) проходят для trained-assist-agent

## Нейминг (Alesa → trained-assist)

- [реализовано] trained-assist-agent.service → assist-agent.service (systemd)
- [реализовано] переименован в assist-agent-ru.service (ранее alesa-agent-ru.service)
- [реализовано] package.json name: trained-assist-agent / trained-assist-tg-bot
- [реализовано] Удалено "Алеса" из cmdVersion, cmdPrivacy

## Пин контекст карточка

- [реализовано] Пин показывает КОНТЕКСТ (подключённые скиллы, активная вакансия) — не прогресс задачи
- [реализовано] agent/runner.js: buildContextCard() — строит карточку контекста из скиллов пользователя
- [реализовано] agent/runner.js: updateContextPin() — редактирует существующее пин-сообщение или создаёт+пинит новое; состояние хранится в ~/users/{username}/.pin_state.json на VM
- [реализовано] PR #20 (feat/pinned-message-update-v2): бот передаёт pinnedMsgId агенту; initialMsgId и pinnedMsgId — РАЗНЫЕ сообщения (initialMsgId = новый "⏳ Запускаю…" для стриминга, pinnedMsgId = контекст)
- [реализовано] buildContextCard: для object-значений (vacancies) извлекает .title/.name вместо JSON.stringify (commit 7dd48e1 на VM ветке docs/architecture)
- [реализовано] Накопившиеся старые пин-сообщения ("⏳ Запускаю…") — очищены через unpinAllChatMessages API

## Иллюстрации и лейблинг (95-illustrate + 96-label)

- [реализовано] Ideogram: не поддерживает кириллицу — buildPrompt всегда без текстовых меток для этого провайдера
- [реализовано] OpenAI: переход с dall-e-3 на gpt-image-1 (новый API — возвращает b64_json, не URL)
- [реализовано] gpt-image-1: b64_json сохраняется в agent-data/images/, отдаётся через GET /images/:filename (public, без auth)
- [реализовано] labels_mode: embedded/caption/none — три режима меток (PR #224 от другой сессии Claude)
- [реализовано] Billing error detection: OpenAI insufficient_quota → понятное сообщение пользователю
- [реализовано] 96-label.js: новый скилл для оверлея кириллических подписей через sharp+SVG
  - AUTO режим: structures[] → Claude Vision (claude-haiku) определяет позиции автоматически
  - MANUAL режим: labels[] с явными x,y координатами для итерации
  - Возвращает detected_positions для ручной корректировки
  - Итерационный тип: copy detected_positions и adjust x/y
- [реализовано] server.js: GET /images/:filename — публичный route ДО auth gate (Telegram скачивает без токена)
- [реализовано] AGENT_BOT_TOKEN/AGENT_CHAT_ID в image_label (не TELEGRAM_*)
- [планируется] Recraft v3 как третий провайдер с поддержкой русского текста (нужен RECRAFT_API_KEY)
- [планируется] Vision pass для AUTO режима image_label — нужен ANTHROPIC_API_KEY в secrets.env (сейчас только внутри Claude Code процесса)

## Групповые режимы

- [реализовано] /all_on — режим "все сообщения → агенту" для групп: бот обрабатывает все сообщения без repl/mention; индикатор 🔴 пинится в чате; /all_off — выключает режим и восстанавливает пин агента. Prereq: Group Privacy OFF в BotFather (/setprivacy → Disable)

## Безопасность

- [реализовано] AGENT_SECRET — Bearer auth между CF Worker и агентами
- [реализовано] BOT_SECRET — auth между ботом и token-relay
- [реализовано] RELAY_BOT_SECRET — auth для команд через relay
- [реализовано] Пароли пользователей — scrypt hash в Cloudflare KV
- [реализовано] Исправлен path traversal в /files и /files/read (startsWith → !== + startsWith+sep)
- [реализовано] Webhook secret_token (issue #1302 §4.3): валидация X-Telegram-Bot-Api-Secret-Token до изменения state; скрипт scripts/set-webhook.mjs

## Мульти-бот (delivery) — issue #1302 PR-A2

- [реализовано] resolveAudience(env) — единый резолвер audience (default/recruiter/freelance) вместо 5× тернарника SESSION_NAMESPACE
- [реализовано] [env.freelance] в wrangler.toml: Worker trained-assist-tg-bot-freelance, SESSION_NAMESPACE=freelance, USERS общий с prod, SESSIONS — отдельный KV (52240aec…), свои DO-миграции, MEDIA_PIPELINE=off. Инертен пока не provisioned FREELANCE_BOT_TOKEN
- [реализовано] applySessionNamespace идемпотентен и префиксует list() (src/lib/session-namespace.js, общий для index.js и intake-buffer.js)
- [реализовано] commands-registry.json: поле audiences + один helper видимости (src/lib/command-visibility.js) для /start и setMyCommands
- [реализовано] ensureCommandsRegisteredOnce: ключ botId+digest, флаг ставится только после успешного await
- [реализовано] ci.yml: deploy/smoke loop по main/recruiter/freelance; smoke проверяет buildSha + getMe; freelance пропускается с warning без токена
- [планируется] Включить freelance env + canary на тестовом чате с реальным третьим ботом (отдельный шаг после merge)

## Команды — единый fallback для незарегистрированных

- [реализовано] Единый fallback для незарегистрированных команд (#249): `known command → свой handler`, `unknown command → агенту как обычный запрос`. `default:` в `src/handlers/commands.js` вызывает `handleMessage(msg, env)` вместо «❓ Неизвестная команда». Generic — без списка/registry неизвестных команд, без нового логирования. `commands-registry.json` остаётся для меню и маршрутизации известных команд, но отсутствие команды в нём не мешает обратиться к агенту. Покрывает все окружения этого воркера (main/recruiter/freelance/будущие).

## 2026-09-24 — freelance-бот запущен, intake, env

- [реализовано] freelance-бот @freelance_spec_bot включён: Worker + секреты, вебхук на https://tg-freelance.trainedassist.store/webhook (кастомный домен — Telegram не резолвил свежий `*.workers.dev`)
- [реализовано] регистрация команд freelance: `/spec_generation_defaults`, `/spec_generation_explained` (#243), `/remember` (#245); `audience=freelance`, в основном/рекрутерском боте их нет
- [реализовано] `/clean_buffer` (#247): сброс залипшего intake-буфера этого чата (busy → отказ); не трогает идущую задачу
- [реализовано] `DEEPGRAM_API_KEY` выставлен на freelance-Worker (голосовые падали 401 → «Вложение не удалось подготовить»)
- [реализовано] (agent #1334) gate авто-запуска: non-reasoning модель + robust parse — «текст не запускался» починен
- [планируется] #248 системная устойчивость intake (dead-end при insufficient/ошибке, fail-open, TTL/индикатор, видимость failed)
- [планируется] #246 env/секреты ботов в provisioning (новый бот — без ручных шагов)
- [планируется] #251 всегда копим вход (тихо при `all_off`), ACK по `all_on`, TTL 6ч, flush-all

## 2026-09-25 — forum topic isolation (#255)
- Canonical `conversationKey`/`deliveryContext`/`threadExtra`/`threadIdOf` helpers: no valid `message_thread_id` → exactly legacy `String(chatId)`, and no `message_thread_id` sent in any Telegram request (hard guard, no migration).
- Intake DO is keyed by `chatId:threadId` (routeText ingest/append/flush, callbacks `intake_run`, debug routes); text A → text B → flush A keeps the buffers separate.
- `MediaJob` deliver/notify-failure returns `media-result` to the originating topic's DO, so media in A never surfaces in B.
- Every gateway outbound new-message path carries the topic: intake-buffer collector/held/ack/error/placeholder, handler sends, callbacks, commands, intake-preflight, transcript documents.
- Session split: ChatState (auth/username/allMsgMode) stays at `String(chatId)`; ThreadState (dialog/project/picker/supplement/pin pointers) stored at `chatId:threadId` and merged on read; project picker mirror is topic-keyed; `stopTask` scoped by (username, chatId, threadId).
- Tests: `conversation-context`, `forum-topics-isolation`, `forum-topics-routing`, + topic cases in `route-text` (full suite 544 green).
