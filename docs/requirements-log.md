# Alesa — Requirements Log

## Реализовано

- [реализовано] Telegram бот на GCP VM с long polling (Telegraf v4)
- [реализовано] Маршрутизация сессий: 0 сессий → новая; ключевые слова → новая; 1 сессия → продолжить молча; N сессий → Haiku + inline keyboard
- [реализовано] Запуск Claude через `claude --dangerously-skip-permissions`, вывод стримится в Telegram (редактирует "⏳ Думаю…" каждые 3с)
- [реализовано] Dual-auth: OAuth (первичный) → API Key (fallback). При сбое — автоматический recovery
- [реализовано] Mac Keychain sync: auth-sync-server на Mac + cloudflare tunnel → SCP токена на VM
- [реализовано] Admin group (`-5308931318`): уведомления о запуске и auth, только `/reauth` в группе
- [реализовано] Профиль пользователя: `/me`, `/setabout`, `/setprefs` → JSON в workDir
- [реализовано] Per-user task queue: пока Claude думает, новые сообщения встают в очередь, не запускают параллельный процесс
- [реализовано] Live log viewer: каждая задача получает уникальный taskId, ссылка в кнопке "👀 Следить за процессом" на сообщении "⏳ Думаю…". Страница `http://136.65.7.197:8080/?t=alesa2026&id=TASK_ID` показывает живой вывод Claude. Изолирована per-task, per-user.
- [реализовано] Fix: Telegraf crash от 90-секундного таймаута — все обработчики fire-and-forget
- [реализовано] Voice → Deepgram транскрипция → Claude
- [реализовано] Photo/document handler: сохраняет файл в workDir, передаёт путь Claude

## Планируется

- [планируется] **Обработка bulk PII (файлы с телефонами, мейлами)** — ephemeral processing паттерн:
  1. После обработки и экспорта — auto-delete файла из workDir (сейчас файлы остаются)
  2. При получении файла с >500 строк и телефоноподобными данными — показать пользователю: "Файл содержит PII (~N записей). Обработаю и удалю после экспорта в [destination]."
  3. Хэширование НЕ нужно — мы не храним, только routing (принял → преобразовал → залил → удалил). Хэш нужен только если нужно хранить и потом дедублировать локально.
  4. Secret Manager для bulk data НЕ использовать — там лимит операций. Только для credentials (API ключи, токены, пароли).
  5. **Safe zone папка** `{workDir}/.safe/` — gitignored, не пушится. Содержит: временные PII-файлы (uploads/) + refs.json (Google Doc/Sheet IDs, внешние ссылки). Google Doc ID — это reference, не credential: без OAuth не откроешь, в Secret Manager не нужен. Исключение: если документ "доступен всем у кого есть ссылка" — тогда ID = credential уровня 2.
  6. **Уведомление при bulk upload** — показать пользователю: "Получил файл с ~N записями PII. Обработаю и удалю. Куда экспортировать результат — пришли ссылку на Google Sheet."



- [реализовано] `/version` команда — показывает git hash и время запуска

- [реализовано] **Chrome-расширение: бот-сторона** — команды `/chromeext_connect` (генерирует 6-значный код через token-relay, 10 мин TTL) и `/chromeext_status` (проверяет, подключено ли расширение). Намеренно длинные имена команд — без конфликта с `/reauth` и системным `/status`.

- [реализовано] **token-relay** — отдельный HTTP-сервис (`token-relay/index.js`, порт 8081). Эндпоинты: `POST /generate-pair-code` (бот → relay, auth BOT_SECRET), `POST /pair` (расширение → relay, по коду), `POST /save-token` (расширение → relay, паринг-токен + label), `GET /status/:userId` (бот → relay). Уведомляет пользователя через Telegram API напрямую.

- [планируется] **Chrome-расширение: клиентская часть** — MV3 расширение в отдельном репо `trained-assist/alesa-auth-extension`. Popup с полем для кода (паринг), затем авто-перехват токенов сервисов (cookies/headers) и отправка через `POST /save-token` в relay.

- [планируется] `BOT_SECRET` в GCP Secret Manager — нужно добавить вручную через `gcloud secrets create BOT_SECRET --data-file=-` на VM

- [планируется] **State management при deploy** — три части:
  1. **Deploy health-check скрипт** (`deploy-check.sh`): после каждого деплоя проверяет что все сервисы живые — `alesa.service` active, `ttyd.service` active, `cloudflared-tunnel.service` active, лог-сервер отвечает на :8080, OAuth-токен валиден (`claude --version` не падает). Результат → одно сообщение в admin group.
  2. **State cleanup** (`state-cleanup.sh`): убивает зависшие tmux-сессии старше N часов без активности, чистит старые файлы из workDir (img-*, file-* старше 7 дней), чистит старый Claude output из `/tmp`. Запускать по cron или вручную.
  3. **State manifest** — описание всего state на VM в одном месте (сейчас размазан по памяти/файлам): tmux-сессии, workDir файлы, auth-токен, in-memory очереди. Нужно чтобы при деплое было понятно что сломалось и что осталось от предыдущего запуска.
