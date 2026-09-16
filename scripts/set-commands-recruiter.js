#!/usr/bin/env node
// One-time script: registers the recruiter bot's command list in Telegram.
// Same backend/MCP as the main bot, but the menu is pinned to the recruiting
// domain so recruiter users aren't hunting through general-purpose commands.
// Usage: BOT_TOKEN=xxx node scripts/set-commands-recruiter.js

const token = process.env.BOT_TOKEN || process.argv[2];
if (!token) {
  console.error('Usage: BOT_TOKEN=xxx node scripts/set-commands-recruiter.js');
  process.exit(1);
}

const commands = [
  { command: 'stop', description: 'Остановить сессию и сохранить весь ввод' },
  { command: 'skip', description: 'Перейти к следующему вводу — появилась новая информация' },
  { command: 'fresh', description: 'Начать без незавершённого ввода' },
  { command: 'login',            description: 'Войти: /login username password' },
  { command: 'new_job_post',     description: 'Новая вакансия HeadHunter' },
  { command: 'hh_status',        description: 'Статус фоновой оценки кандидатов' },
  { command: 'cancel_vacancy',   description: 'Отменить создание вакансии' },
  { command: 'sessions',         description: 'Мои диалоги' },
  { command: 'new_dialog',       description: 'Новый диалог' },
  { command: 'profile',          description: 'Мой профиль и смена аккаунта' },
  { command: 'skills',           description: 'Что умеет агент' },
  { command: 'status',           description: 'Статус агента' },
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
