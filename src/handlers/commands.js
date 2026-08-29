import { sendMessage } from '../lib/telegram.js';
import { getSession, setSession, deleteSession } from '../lib/kv.js';
import { getUser } from '../lib/kv.js';
import { getAgentHealth } from '../lib/agent-client.js';
import { verifyPassword } from '../lib/auth.js';

export async function handleCommand(msg, env) {
  const { chat, text, from } = msg;
  const chatId = chat.id;
  const cmd = text.split(' ')[0].split('@')[0]; // strip @botname

  switch (cmd) {
    case '/start':   return cmdStart(chatId, env);
    case '/login':   return cmdLogin(msg, env);
    case '/logout':  return cmdLogout(chatId, env);
    case '/status':  return cmdStatus(chatId, env);
    case '/version': return cmdVersion(chatId, env);
    case '/privacy':          return cmdPrivacy(chatId, env);
    case '/chromeext_install': return cmdChromeExtInstall(chatId, env);
    // TODO: /sessions, /me, /setabout, /setprefs, /terminal, /chromeext_connect, /chromeext_status
    default:
      return sendMessage(env.BOT_TOKEN, chatId, '❓ Неизвестная команда. Напиши /start для списка команд.');
  }
}

async function cmdStart(chatId, env) {
  const session = await getSession(env.SESSIONS, chatId);
  if (!session) {
    return sendMessage(env.BOT_TOKEN, chatId,
      '👋 Привет!\n\nЧтобы начать работу:\n<code>/login username password</code>'
    );
  }
  return sendMessage(env.BOT_TOKEN, chatId,
    `👋 Привет, ${session.name}!\n\n` +
    `Просто пиши задачи — я передам их Claude Code.\n\n` +
    `Команды:\n/status — статус\n/logout — выйти`
  );
}

async function cmdLogin(msg, env) {
  const { chat, text } = msg;
  const chatId = chat.id;
  const args = text.trim().split(/\s+/);
  if (args.length < 3) {
    return sendMessage(env.BOT_TOKEN, chatId, 'Использование: /login username password');
  }
  const [, username, password] = args;

  const existing = await getSession(env.SESSIONS, chatId);
  if (existing) {
    return sendMessage(env.BOT_TOKEN, chatId,
      `✅ Ты уже вошёл как ${existing.name}. /logout чтобы выйти.`
    );
  }

  const user = await getUser(env.USERS, username);
  if (!user) {
    return sendMessage(env.BOT_TOKEN, chatId, '❌ Пользователь не найден.');
  }

  const ok = await verifyPassword(password, user.passwordHash, user.salt);
  if (!ok) {
    return sendMessage(env.BOT_TOKEN, chatId, '❌ Неверный пароль.');
  }

  await setSession(env.SESSIONS, chatId, { username, name: user.name });
  return sendMessage(env.BOT_TOKEN, chatId,
    `✅ Добро пожаловать, ${user.name}!\n\nПросто пиши задачи — я передам их Claude Code.`
  );
}

async function cmdLogout(chatId, env) {
  const session = await getSession(env.SESSIONS, chatId);
  if (!session) {
    return sendMessage(env.BOT_TOKEN, chatId, '⚠️ Ты не авторизован.');
  }
  await deleteSession(env.SESSIONS, chatId);
  return sendMessage(env.BOT_TOKEN, chatId,
    `👋 До встречи, ${session.name}! Для входа: /login username password`
  );
}

async function cmdStatus(chatId, env) {
  const session = await getSession(env.SESSIONS, chatId);
  if (!session) return sendMessage(env.BOT_TOKEN, chatId, '⚠️ Ты не авторизован. /login username password');

  const agentOk = await getAgentHealth(env);
  return sendMessage(env.BOT_TOKEN, chatId,
    `📊 <b>${session.name}</b>\n` +
    `Агент: ${agentOk ? '✅ онлайн' : '❌ офлайн'}\n\n` +
    `TODO: показать активные сессии`
  );
}

async function cmdVersion(chatId, env) {
  // TODO: fetch version from agent
  return sendMessage(env.BOT_TOKEN, chatId,
    `🤖 <b>Alesa Bot</b>\nWorker — Cloudflare\nAgent — GCP VM\n\nTODO: показывать git hash`
  );
}

async function cmdChromeExtInstall(chatId, env) {
  return sendMessage(env.BOT_TOKEN, chatId,
    `🧩 <b>Установка Cloud Auth Bridge</b>\n\n` +
    `<b>Шаг 1.</b> Скачай расширение:\n` +
    `<a href="https://github.com/trained-assist/cloud-auth-bridge/releases/latest/download/cloud-auth-bridge.zip">📦 cloud-auth-bridge.zip</a>\n\n` +
    `<b>Шаг 2.</b> Распакуй ZIP в любую папку (запомни куда).\n\n` +
    `<b>Шаг 3.</b> Открой Chrome → <code>chrome://extensions</code>\n` +
    `Включи <b>Режим разработчика</b> (переключатель справа вверху).\n` +
    `Нажми <b>Загрузить распакованное</b> → выбери папку из шага 2.\n\n` +
    `<b>Шаг 4.</b> Отправь /chromeext_connect — получишь 6-значный код.\n` +
    `Кликни на иконку расширения → введи код → <b>Подключить</b>.\n\n` +
    `Готово! Расширение будет автоматически переносить токены авторизации на VM.`
  );
}

async function cmdPrivacy(chatId, env) {
  return sendMessage(env.BOT_TOKEN, chatId,
    `🔒 <b>Как Алеса работает с данными</b>\n\n` +
    `Сообщения → Claude Code на GCP VM.\n` +
    `Сессии → Cloudflare KV (зашифровано).\n` +
    `Файлы → временная папка на VM, удаляются после обработки.\n` +
    `Пароли → Cloudflare KV (scrypt hash).\n\n` +
    `Написать "удали мои данные" — Алеса очистит всё.`
  );
}
