#!/usr/bin/env node
// One-time script: registers bot command list in Telegram
// Usage: BOT_TOKEN=xxx node scripts/set-commands.js

const token = process.env.BOT_TOKEN || process.argv[2];
if (!token) {
  console.error('Usage: BOT_TOKEN=xxx node scripts/set-commands.js');
  process.exit(1);
}

const commands = [
  { command: 'stop', description: 'Остановить сессию и сохранить весь ввод' },
  { command: 'skip', description: 'Перейти к следующему вводу — появилась новая информация' },
  { command: 'fresh', description: 'Начать без незавершённого ввода' },
  { command: 'profile',          description: 'Мой профиль и смена аккаунта' },
  { command: 'sessions',         description: 'Мои диалоги' },
  { command: 'new_dialog',       description: 'Новый диалог' },
  { command: 'skills',           description: 'Что умеет агент' },
  { command: 'files',            description: 'Файлы и папки' },
  { command: 'status',           description: 'Статус агента' },
  { command: 'settoken',         description: 'Сохранить токен сервиса' },
  { command: 'chromeext_install',description: 'Установить Chrome-расширение' },
  { command: 'chromeext_connect',description: 'Подключить расширение' },
  { command: 'chromeext_status', description: 'Статус расширения' },
  { command: 'ru',               description: 'Задача через РФ IP (nalog.ru и т.п.)' },
  { command: 'logout',           description: 'Выйти' },
];

const res = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ commands }),
});
const json = await res.json();
if (json.ok) {
  console.log(`✅ Зарегистрировано ${commands.length} команд.`);
} else {
  console.error('❌ Ошибка:', JSON.stringify(json));
  process.exit(1);
}
