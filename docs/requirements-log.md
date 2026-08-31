# Requirements Log — Alesa (trained-assist-tg-bot)

## Инфраструктура

- [реализовано] Cloudflare Worker (Hono) — Telegram webhook handler, stateless, без состояния
- [реализовано] GCP VM 136.65.7.197 — основной агент (trained-assist-agent), запускает Claude сессии через `claude --dangerously-skip-permissions`
- [реализовано] Hostland VM 178.212.14.192 — RU IP агент (trained-assist-agent та же кодовая база), для российских гео-блокированных сервисов
  - 8GB RAM, 4 vCore, 60GB NVMe, Москва, 862₽/мес
  - HTTPS: https://178-212-14-192.sslip.io
  - Запускается как systemd сервис assist-agent (SECRETS_SOURCE=env)
- [реализовано] nginx + Let's Encrypt на обоих VM
- [реализовано] Per-user изоляция: ~/users/{username}/ на каждом VM

## Аутентификация и токены

- [реализовано] Chrome extension (cloud-auth-bridge) — захватывает куки и sessionStorage с сайтов
- [реализовано] Token relay (GCP VM :8081) — паринг расширения с ботом по 6-значному коду
- [реализовано] Автоматическое сохранение токенов в ~/agent-tokens/{userId}/{label} на GCP VM
- [реализовано] Форвардинг токенов на RU VM — token-relay дублирует все токены на https://178-212-14-192.sslip.io/tokens
- [реализовано] nalog.ru sessionStorage захват — Chrome extension читает auth.token и refresh.token через chrome.scripting.executeScript
- [реализовано] /settoken — ручное сохранение токена через Telegram команду
- [реализовано] /chromeext_connect — паринг Chrome расширения через 6-значный код

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
  - URL: https://136-65-7-197.sslip.io/browser/
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

## Безопасность

- [реализовано] AGENT_SECRET — Bearer auth между CF Worker и агентами
- [реализовано] BOT_SECRET — auth между ботом и token-relay
- [реализовано] RELAY_BOT_SECRET — auth для команд через relay
- [реализовано] Пароли пользователей — scrypt hash в Cloudflare KV
- [реализовано] Исправлен path traversal в /files и /files/read (startsWith → !== + startsWith+sep)
