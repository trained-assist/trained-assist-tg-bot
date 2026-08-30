# Requirements Log — Alesa (trained-assist-tg-bot)

## Инфраструктура

- [реализовано] Cloudflare Worker (Hono) — Telegram webhook handler, stateless, без состояния
- [реализовано] GCP VM 136.65.7.197 — основной агент (alesa-agent), запускает Claude сессии через `claude --dangerously-skip-permissions`
- [реализовано] Hostland VM 178.212.14.192 — RU IP агент (alesa-agent та же кодовая база), для российских гео-блокированных сервисов
  - 8GB RAM, 4 vCore, 60GB NVMe, Москва, 862₽/мес
  - HTTPS: https://178-212-14-192.sslip.io
  - Запускается как systemd сервис alesa-agent (SECRETS_SOURCE=env)
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
- [реализовано] Классификация сообщений — Haiku определяет в какой диалог добавить сообщение
- [реализовано] Дизамбигуация — инлайн клавиатура при неоднозначной маршрутизации

## Гео-блокировка

- [реализовано] nalog.ru (lknpd.nalog.ru) недоступен с GCP VM (EU) — решено через RU VM
- [отклонено] Playwright для nalog.ru на GCP VM — гео-блок, не работает
- [планируется] gosuslugi.ru, mos.ru и другие РФ-сервисы через RU VM

## Playwright / Browser automation

- [реализовано] Playwright MCP на каждом VM — per-user Chrome profiles
- [реализовано] ~/.claude/scripts/pw.sh — автодетект аккаунта по CWD

## Безопасность

- [реализовано] AGENT_SECRET — Bearer auth между CF Worker и агентами
- [реализовано] BOT_SECRET — auth между ботом и token-relay
- [реализовано] RELAY_BOT_SECRET — auth для команд через relay
- [реализовано] Пароли пользователей — scrypt hash в Cloudflare KV
