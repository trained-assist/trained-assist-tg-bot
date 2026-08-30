import { sendMessage, sendMessageWithKeyboard } from '../lib/telegram.js';
import { getSession, setSession, deleteSession } from '../lib/kv.js';
import { getUser } from '../lib/kv.js';
import { getAgentHealth, getSessions, getFiles, runTask } from '../lib/agent-client.js';
import { verifyPassword } from '../lib/auth.js';
import { setUserToken } from '../lib/agent-client.js';

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
    case '/settoken':          return cmdSetToken(msg, env);
    case '/chromeext_install': return cmdChromeExtInstall(chatId, env);
    case '/chromeext_connect': return cmdChromeExtConnect(chatId, env);
    case '/chromeext_status':  return cmdChromeExtStatus(chatId, env);
    case '/sessions':
    case '/диалоги':           return cmdSessions(chatId, env);
    case '/new_dialog':
    case '/новый_диалог':      return cmdNewDialog(chatId, env);
    case '/files':
    case '/папки':             return cmdFiles(chatId, env);
    case '/ru':                return cmdRu(msg, env);
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
    `<b>Команды:</b>\n` +
    `/sessions — мои диалоги\n` +
    `/files — файлы и папки\n` +
    `/status — статус агента\n` +
    `/ru &lt;задача&gt; — задача через РФ IP (nalog.ru и т.п.)\n` +
    `/settoken — сохранить токен сервиса\n` +
    `/chromeext_connect — подключить Chrome-расширение\n` +
    `/chromeext_install — установить расширение\n` +
    `/logout — выйти`
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

  const [agentOk, agentRuOk] = await Promise.all([
    getAgentHealth(env),
    env.AGENT_RU_URL ? getAgentHealth({ ...env, AGENT_URL: env.AGENT_RU_URL }) : Promise.resolve(null),
  ]);

  const ruLine = agentRuOk !== null
    ? `\nRU-агент: ${agentRuOk ? '✅ онлайн' : '❌ офлайн'} (nalog.ru, РФ-сервисы)`
    : '';

  return sendMessage(env.BOT_TOKEN, chatId,
    `📊 <b>${session.name}</b>\n` +
    `Агент: ${agentOk ? '✅ онлайн' : '❌ офлайн'}` +
    ruLine
  );
}

async function cmdRu(msg, env) {
  const { chat, text } = msg;
  const chatId = chat.id;
  const session = await getSession(env.SESSIONS, chatId);
  if (!session) return sendMessage(env.BOT_TOKEN, chatId, '⚠️ Сначала войди: /login username password');

  const task = text.replace(/^\/ru\s*/i, '').trim();
  if (!task) {
    return sendMessage(env.BOT_TOKEN, chatId,
      '🇷🇺 <b>Российский IP агент</b>\n\n' +
      'Используй: <code>/ru ваша задача</code>\n\n' +
      'Задачи, переданные через /ru, выполняются на VM с российским IP-адресом.\n' +
      'Нужно для: nalog.ru, gosuslugi.ru и других РФ-сервисов.\n\n' +
      'Пример: <code>/ru проверь мои доходы на nalog.ru</code>'
    );
  }

  if (!env.AGENT_RU_URL) {
    return sendMessage(env.BOT_TOKEN, chatId, '❌ RU-агент не настроен.');
  }

  try {
    const sessionId = `s-${chatId}-${Date.now()}`;
    await runTask(env, {
      userId: chatId,
      username: session.username,
      task,
      context: null,
      sessionId,
      forceRu: true,
    });
    await setSession(env.SESSIONS, chatId, {
      ...session,
      lastSessionId: sessionId,
      lastMessageAt: Date.now(),
    });
  } catch (err) {
    await sendMessage(env.BOT_TOKEN, chatId, `❌ Ошибка RU-агента: ${err.message}`);
  }
}

async function cmdVersion(chatId, env) {
  // TODO: fetch version from agent
  return sendMessage(env.BOT_TOKEN, chatId,
    `🤖 <b>Alesa Bot</b>\nWorker — Cloudflare\nAgent — GCP VM\n\nTODO: показывать git hash`
  );
}

async function cmdSetToken(msg, env) {
  const { chat, text } = msg;
  const chatId = chat.id;
  const session = await import('../lib/kv.js').then(m => m.getSession(env.SESSIONS, chatId));
  if (!session) return sendMessage(env.BOT_TOKEN, chatId, '⚠️ Сначала войди: /login username password');

  const args = text.trim().split(/\s+/);
  if (args.length < 3) {
    return sendMessage(env.BOT_TOKEN, chatId,
      '📝 Использование: <code>/settoken &lt;сервис&gt; &lt;токен&gt;</code>\n\n' +
      'Примеры:\n' +
      '<code>/settoken github ghp_xxxxxxxxxxxx</code>\n' +
      '<code>/settoken figma xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx</code>\n' +
      '<code>/settoken notion secret_xxxxxx</code>\n\n' +
      'GitHub PAT: <a href="https://github.com/settings/tokens/new">создать токен</a> (нужны scope: repo, read:org)'
    );
  }
  const [, label, value] = args;

  try {
    await setUserToken(env, { userId: chatId, label: label.toLowerCase(), value });
    return sendMessage(env.BOT_TOKEN, chatId,
      `✅ Токен <b>${label}</b> сохранён. Клод увидит его в следующей задаче.`
    );
  } catch (e) {
    return sendMessage(env.BOT_TOKEN, chatId, `❌ Ошибка: ${e.message}`);
  }
}

async function cmdChromeExtConnect(chatId, env) {
  try {
    const res = await fetch(`${env.RELAY_URL}/generate-pair-code`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.RELAY_BOT_SECRET}`,
      },
      body: JSON.stringify({ userId: chatId }),
    });
    if (!res.ok) throw new Error(`relay ${res.status}`);
    const { code } = await res.json();
    return sendMessage(env.BOT_TOKEN, chatId,
      `🔗 <b>Код подключения расширения</b>\n\n` +
      `<code>${code}</code>\n\n` +
      `Действует 10 минут. Введи его в попапе расширения Cloud Auth Bridge → <b>Подключить</b>.\n\n` +
      `Расширение не установлено? → /chromeext_install`
    );
  } catch (e) {
    return sendMessage(env.BOT_TOKEN, chatId, `❌ Ошибка генерации кода: ${e.message}`);
  }
}

async function cmdChromeExtStatus(chatId, env) {
  try {
    const res = await fetch(`${env.RELAY_URL}/status/${chatId}`, {
      headers: { 'Authorization': `Bearer ${env.RELAY_BOT_SECRET}` },
    });
    if (!res.ok) throw new Error(`relay ${res.status}`);
    const { connected } = await res.json();
    return sendMessage(env.BOT_TOKEN, chatId,
      connected
        ? '✅ Chrome-расширение подключено и активно.'
        : '❌ Расширение не подключено. Используй /chromeext_connect для привязки.'
    );
  } catch (e) {
    return sendMessage(env.BOT_TOKEN, chatId, `❌ Ошибка проверки статуса: ${e.message}`);
  }
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

export function timeAgo(ts) {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return 'только что';
  if (m < 60) return `${m}м`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}ч`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}д`;
  return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

async function cmdSessions(chatId, env) {
  const session = await getSession(env.SESSIONS, chatId);
  if (!session) return sendMessage(env.BOT_TOKEN, chatId, '⚠️ Сначала войди: /login username password');

  let list;
  try {
    list = await getSessions(env, { username: session.username, limit: 8 });
  } catch (e) {
    return sendMessage(env.BOT_TOKEN, chatId, `❌ Не удалось получить диалоги: ${e.message}`);
  }

  if (!list || list.length === 0) {
    return sendMessage(env.BOT_TOKEN, chatId,
      '📭 Нет сохранённых диалогов.\n\nПросто напиши задачу — она станет первым диалогом.'
    );
  }

  // Tapping a session opens action submenu, not immediate continue
  const buttons = list.map(s => {
    const label = `${s.topic.slice(0, 32)} · ${timeAgo(s.lastAt)}`;
    return [{ text: label, callback_data: `sd:${s.id}` }];
  });
  buttons.push([{ text: '✨ Новый диалог', callback_data: 'nd:' }]);

  return sendMessageWithKeyboard(
    env.BOT_TOKEN, chatId,
    '💬 <b>Диалоги</b>\n\nВыбери диалог:',
    buttons
  );
}

async function cmdNewDialog(chatId, env) {
  const session = await getSession(env.SESSIONS, chatId);
  if (!session) return sendMessage(env.BOT_TOKEN, chatId, '⚠️ Сначала войди: /login username password');

  return sendMessageWithKeyboard(
    env.BOT_TOKEN, chatId,
    '✨ <b>Новый диалог</b>\n\nМожете просто начать писать — или загрузить контекст из одного из прошлых диалогов:',
    [
      [{ text: '✏️ Чистый лист — просто начну писать', callback_data: 'nd:clean' }],
      [{ text: '📚 Выбрать диалог и загрузить контекст', callback_data: 'nd:ctx' }],
    ]
  );
}

export async function cmdFiles(chatId, env, relPath = '') {
  const session = await getSession(env.SESSIONS, chatId);
  if (!session) return sendMessage(env.BOT_TOKEN, chatId, '⚠️ Сначала войди: /login username password');

  let data;
  try {
    data = await getFiles(env, { username: session.username, path: relPath });
  } catch (e) {
    return sendMessage(env.BOT_TOKEN, chatId, `❌ Ошибка: ${e.message}`);
  }

  const { entries, path: currentPath } = data;

  if (!entries || entries.length === 0) {
    return sendMessage(env.BOT_TOKEN, chatId, `📂 <code>${currentPath || '/'}</code>\n\n(пусто)`);
  }

  function fmtSize(bytes) {
    if (bytes < 1024) return `${bytes}б`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}кб`;
    return `${(bytes / 1024 / 1024).toFixed(1)}мб`;
  }

  const buttons = [];

  // Back button (not at root)
  if (currentPath) {
    const parent = currentPath.includes('/') ? currentPath.slice(0, currentPath.lastIndexOf('/')) : '';
    buttons.push([{ text: '⬆️ Назад', callback_data: `fl:${parent}` }]);
  }

  // Directory and file entries
  for (const e of entries) {
    const entryPath = currentPath ? `${currentPath}/${e.name}` : e.name;
    // callback_data max 64 bytes — truncate path if needed
    const pathKey = entryPath.slice(0, 58);

    if (e.type === 'dir') {
      const label = `📁 ${e.name}  (${e.count})`;
      buttons.push([{ text: label, callback_data: `fl:${pathKey}` }]);
    } else {
      const ext = e.name.split('.').pop().toLowerCase();
      const icon = ext === 'md' ? '📄' : ext === 'json' ? '📋' : '📃';
      const label = `${icon} ${e.name}  ${fmtSize(e.size)}`;
      buttons.push([{ text: label, callback_data: `fr:${pathKey}` }]);
    }
  }

  const title = currentPath ? `📂 <code>${currentPath}</code>` : '📂 <b>Файлы</b>';
  return sendMessageWithKeyboard(env.BOT_TOKEN, chatId, title, buttons);
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
