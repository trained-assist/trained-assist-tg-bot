import { sendMessage } from '../lib/telegram.js';
import { getSession } from '../lib/kv.js';
import { getAgentHealth } from '../lib/agent-client.js';

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
    case '/privacy': return cmdPrivacy(chatId, env);
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
  const args = text.trim().split(/\s+/);
  if (args.length < 3) {
    return sendMessage(env.BOT_TOKEN, chat.id, 'Использование: /login username password');
  }
  const [, username, password] = args;

  // TODO: verify password against USERS KV (scrypt hash check via agent or locally)
  // For now: delegate auth to agent
  // const user = await verifyLogin(env.USERS, username, password);

  return sendMessage(env.BOT_TOKEN, chat.id,
    '⚠️ Авторизация через агент — TODO: реализовать проверку пароля из USERS KV.'
  );
}

async function cmdLogout(chatId, env) {
  // TODO: delete from env.SESSIONS
  return sendMessage(env.BOT_TOKEN, chatId,
    '👋 Выход. Для входа: /login username password'
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
