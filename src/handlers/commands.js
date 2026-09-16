import { openProjectChoice } from '../lib/project-choice.js';
import { sendMessage, sendMessageWithKeyboard, pinChatMessage, unpinChatMessage, deleteMessage } from '../lib/telegram.js';
import { getSession, setSession, deleteSession, newSessionId } from '../lib/kv.js';
import { getUser, listUsernames } from '../lib/kv.js';
import { getAgentHealth, getSessions, getFiles, runTask, getSkills, stopTask, reportBugOrFeature } from '../lib/agent-client.js';
import { verifyPassword } from '../lib/auth.js';
import { setUserToken } from '../lib/agent-client.js';
import { handleMessage } from './message.js';
import commandsRegistry from '../../commands-registry.json';

// Commands the agent handles itself (via getQuickAnswer / a session task) rather than
// the gateway. The gateway must forward these to the agent instead of rejecting them as
// "unknown" — otherwise agent-side commands stay invisible until the gateway is
// redeployed. Derived from commands-registry.json (handler: "forward") instead of a
// hand-maintained Set — see that file for the single source of truth + scripts/
// check-commands-registry.js, which is what used to go stale and hide agent commands
// from Telegram until someone remembered to update this list by hand.
const AGENT_FORWARDED_COMMANDS = new Set(
  commandsRegistry.commands
    .filter((c) => c.handler === 'forward')
    .flatMap((c) => [c.command, ...c.aliases])
);

// Admin-only agent commands that must ALSO pass through the admin-group branch in
// index.js (which otherwise only forwards user-mgmt commands and silently drops the
// rest). Without this, /get_webpass typed in the admin group gets no reply at all.
const ADMIN_FORWARDED_COMMANDS = new Set(
  commandsRegistry.commands
    .filter((c) => c.handler === 'forward' && c.adminOnly)
    .flatMap((c) => [c.command, ...c.aliases])
);
export function isAdminForwardedCommand(text) {
  const cmd = (text || '').split(' ')[0].split('@')[0].toLowerCase();
  return ADMIN_FORWARDED_COMMANDS.has(cmd);
}

export async function handleCommand(msg, env) {
  const { chat, text, from } = msg;
  const chatId = chat.id;
  const cmd = text.split(' ')[0].split('@')[0]; // strip @botname

  // Agent-side commands (e.g. /persona) are handled downstream in the agent, not here.
  // Forward the raw message so the agent's task pipeline sees the full text + args.
  if (AGENT_FORWARDED_COMMANDS.has(cmd.toLowerCase())) {
    // Convenience: set the role by REPLYING to a message with just `/persona`.
    // If there's no inline arg (and it isn't a control word), lift the replied-to
    // message's text/caption in as the role body, so users don't retype paragraphs.
    const inline = text.slice(cmd.length).trim();
    const quoted = (msg.reply_to_message?.text || msg.reply_to_message?.caption || '').trim();
    if (quoted && !inline) {
      return handleMessage({ ...msg, text: `${cmd} ${quoted}` }, env);
    }
    return handleMessage(msg, env);
  }

  switch (cmd) {
    case '/start':   return cmdStart(chatId, env);
    case '/login':   return cmdLogin(msg, env);
    case '/logout':   return cmdLogout(chatId, env);
    case '/profile':  return cmdProfile(chatId, env);
    case '/status':  return cmdStatus(chatId, env);
    case '/version': return cmdVersion(chatId, env);
    case '/privacy':          return cmdPrivacy(chatId, env);
    case '/settoken':          return cmdSetToken(msg, env);
    case '/chromeext_install': return cmdChromeExtInstall(chatId, env);
    case '/chromeext_connect': return cmdChromeExtConnect(msg, env);
    case '/chromeext_status':  return cmdChromeExtStatus(msg, env);
    case '/sessions':
    case '/диалоги':           return cmdSessions(chatId, env);
    case '/new_dialog':
    case '/новый_диалог':      return cmdNewDialog(chatId, env);
    case '/close':
    case '/закрыть':           return cmdClose(chatId, env);
    case '/files':
    case '/папки':             return cmdFiles(chatId, env);
    case '/ru':                return cmdRu(msg, env);
    case '/стоп':
    case '/stop':              return cmdStop(msg, env);
    case '/skip':              return cmdStop(msg, env, 'skip');
    case '/fresh':             return cmdStop(msg, env, 'fresh');
    case '/skills':
    case '/скиллы':            return cmdSkills(chatId, env);
    case '/all_on':            return cmdAllOn(msg, env);
    case '/all_off':           return cmdAllOff(msg, env);
    case '/report':
    case '/report_bug_or_feature_request': return cmdReport(msg, env);
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
    `/skills — что умеет агент (список скиллов)\n` +
    `/sessions — мои диалоги\n` +
    `/stop — остановить сессию и сохранить ввод\n` +
    `/skip — перейти к следующему вводу, если появилась новая информация\n` +
    `/fresh — начать без незавершённого ввода\n` +
    `/persona &lt;текст&gt; — роль ассистента для этого профиля (без текста — показать)\n` +
    `/project — проекты профиля: список / сменить / создать (новые сессии идут в активный)\n` +
    `/files — файлы и папки\n` +
    `/status — статус агента\n` +
    `/ru &lt;задача&gt; — задача через РФ IP (nalog.ru и т.п.)\n` +
    `/settoken — сохранить токен сервиса\n` +
    `/report &lt;описание&gt; — сообщить о баге или предложить фичу\n` +
    `/chromeext_connect — подключить Chrome-расширение\n` +
    `/chromeext_install — установить расширение\n` +
    `/logout — выйти`
  );
}

export async function cmdLogin(msg, env) {
  const { chat, text, from } = msg;
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

  const isGroup = ['group', 'supergroup'].includes(chat.type);
  // Uniformity (owner 2026-09-14): a logged-in group must behave like a private chat —
  // EVERY message reaches the intake accumulator. Previously login only asked the user
  // to run /all_on; without it ambient messages fell to the memberCount gate, which
  // fails closed (999) when getChatMemberCount can't read the count → "ноль реакции,
  // старт только реплаем". Auto-enabling allMsgMode here removes that manual step and
  // the flaky-count dependency. Reversible: /all_off turns it back off.
  await setSession(env.SESSIONS, chatId, {
    username, name: user.name, telegramUserId: from?.id,
    ...(isGroup ? { allMsgMode: true } : {}),
  });
  return sendMessage(env.BOT_TOKEN, chatId,
    isGroup
      ? `✅ Добро пожаловать, ${user.name}!\n\n` +
        `Пиши задачи как в личке — я собираю все сообщения и запускаю проработку по кнопке «▶️».\n\n` +
        `Отключить режим «все сообщения → агенту»: <b>/all_off</b>`
      : `✅ Добро пожаловать, ${user.name}!\n\nПросто пиши задачи — я передам их Claude Code.`
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

async function cmdProfile(chatId, env) {
  const session = await getSession(env.SESSIONS, chatId);
  if (!session) {
    return sendMessage(env.BOT_TOKEN, chatId,
      '👤 <b>Профиль</b>\n\nТы не авторизован.\n\n<code>/login username password</code>'
    );
  }

  const allUsernames = await listUsernames(env.USERS);
  const others = allUsernames.filter(u => u !== session.username);

  const buttons = [];
  if (others.length > 0) {
    buttons.push([{ text: '🔄 Сменить профиль', callback_data: 'prof:switch' }]);
  }
  buttons.push([{ text: '🚪 Выйти', callback_data: 'prof:logout' }]);

  return sendMessageWithKeyboard(
    env.BOT_TOKEN, chatId,
    `👤 <b>Профиль</b>\n\n` +
    `Имя: <b>${session.name}</b>\n` +
    `Логин: <code>${session.username}</code>`,
    buttons, {}, env
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
    const sessionId = newSessionId(chatId);
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
  return sendMessage(env.BOT_TOKEN, chatId,
    `🤖 <b>Trained Assist Bot</b>\nWorker — Cloudflare\nAgent — GCP VM`
  );
}

async function cmdSetToken(msg, env) {
  const { chat, text } = msg;
  const chatId = chat.id;
  const session = await getSession(env.SESSIONS, chatId);
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
    await setUserToken(env, { userId: session.username, label: label.toLowerCase(), value });
    return sendMessage(env.BOT_TOKEN, chatId,
      `✅ Токен <b>${label}</b> сохранён. Клод увидит его в следующей задаче.`
    );
  } catch (e) {
    return sendMessage(env.BOT_TOKEN, chatId, `❌ Ошибка: ${e.message}`);
  }
}

async function cmdChromeExtConnect(msg, env) {
  const chatId = msg.chat.id;
  const userId = msg.from?.id || chatId;
  try {
    const res = await fetch(`${env.RELAY_URL}/generate-pair-code`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.RELAY_BOT_SECRET}`,
      },
      body: JSON.stringify({ userId }),
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

async function cmdChromeExtStatus(msg, env) {
  const chatId = msg.chat.id;
  const userId = msg.from?.id || chatId;
  try {
    const res = await fetch(`${env.RELAY_URL}/status/${userId}`, {
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

async function cmdReport(msg, env) {
  const { chat, text } = msg;
  const chatId = chat.id;
  const session = await getSession(env.SESSIONS, chatId);
  if (!session) return sendMessage(env.BOT_TOKEN, chatId, '⚠️ Сначала войди: /login username password');

  const description = text.replace(/^\/report(_bug_or_feature_request)?\s*/i, '').trim();
  if (!description) {
    return sendMessage(env.BOT_TOKEN, chatId,
      '🐛 <b>Сообщить о баге или предложить фичу</b>\n\n' +
      'Использование:\n' +
      '<code>/report описание проблемы или идеи</code>\n\n' +
      'Примеры:\n' +
      '<code>/report при отправке файла бот зависает</code>\n' +
      '<code>/report хочу чтобы можно было скачивать сессии в PDF</code>'
    );
  }

  await sendMessage(env.BOT_TOKEN, chatId, '📤 Создаю issue...');

  try {
    const result = await reportBugOrFeature(env, {
      username: session.username,
      description,
      sessionId: session.activeSessionId || session.lastSessionId || undefined,
    });
    return sendMessage(env.BOT_TOKEN, chatId,
      `✅ <b>Issue создан!</b>\n\n` +
      `<b>#${result.number}</b> ${description.slice(0, 60)}${description.length > 60 ? '…' : ''}\n\n` +
      `<a href="${result.url}">Открыть в GitHub</a>`
    );
  } catch (e) {
    return sendMessage(env.BOT_TOKEN, chatId, `❌ Не удалось создать issue: ${e.message}`);
  }
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

export function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Descriptive session list: a readable text body (number · project · title · gist ·
// meta) plus a compact row of numbered tap-buttons. Replaces the old truncated-label
// button list — users couldn't tell the dialogs apart from a 40-char button. The text
// reads like the agent's own /sessions view (durable summary.gist); the numbers below
// stay one-tap and robust (no ambiguous free-text number parsing).
//   callbackPrefix: 'sd' → open action submenu (continue/info/archive);
//                   'sn' → start new dialog loading that session's context.
// Returns { text, buttons } for sendMessageWithKeyboard.
export function renderSessionList(list, { callbackPrefix = 'sd', header = '💬 <b>Диалоги</b>', hint = 'Выбери номер диалога ниже, чтобы вернуться и продолжить:' } = {}) {
  const lines = [header, '', hint, ''];
  list.forEach((s, i) => {
    const n = i + 1;
    const title = (s.summary && s.summary.title) ? s.summary.title : (s.topic || 'Диалог');
    const gist = s.summary && s.summary.gist ? s.summary.gist : '';
    const proj = s.projectName || s.projectDir || '';
    const count = s.messageCount || (s.messages && s.messages.length) || 0;
    lines.push(`<b>${n}. ${escHtml(title.slice(0, 80))}</b>`);
    if (proj) lines.push(`📁 проект: ${escHtml(proj)}`);
    if (gist) lines.push(escHtml(gist.slice(0, 220)));
    lines.push(`🕒 ${timeAgo(s.lastAt)} · ${count} сообщ.`);
    lines.push('');
  });
  const numBtns = list.map((s, i) => ({ text: String(i + 1), callback_data: `${callbackPrefix}:${s.id}` }));
  const rows = [];
  for (let i = 0; i < numBtns.length; i += 5) rows.push(numBtns.slice(i, i + 5));
  return { text: lines.join('\n').trim(), buttons: rows };
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

  // Descriptive text body + numbered tap-buttons (see renderSessionList).
  // Tapping a number opens the action submenu (sd:), not an immediate continue.
  const { text, buttons } = renderSessionList(list, { callbackPrefix: 'sd' });
  buttons.push([
    { text: '✨ Новый диалог', callback_data: 'nd:' },
    { text: '🗂 Архивировать', callback_data: 'ar:menu' },
  ]);

  return sendMessageWithKeyboard(env.BOT_TOKEN, chatId, text, buttons, {}, env);
}

async function cmdClose(chatId, env) {
  const session = await getSession(env.SESSIONS, chatId);
  if (!session) return sendMessage(env.BOT_TOKEN, chatId, '⚠️ Сначала войди: /login username password');

  await setSession(env.SESSIONS, chatId, {
    ...session,
    activeSessionId: null,
    activeSessionIsNew: false,
    projectSelectionSessionId: null,
    pendingNewProject: false,
    pendingProjectChoice: session.pendingProjectChoice ? { ...session.pendingProjectChoice, suspended: true } : null,
    lastSessionId: null,
    pendingMessage: null,
    pendingMessageAt: null,
    contextFromSession: null,
  });
  return sendMessage(env.BOT_TOKEN, chatId,
    '🔚 <b>Диалог закрыт.</b>\n\nСледующее сообщение начнёт новый диалог с чистого листа.'
  );
}

async function cmdNewDialog(chatId, env) {
  const session = await getSession(env.SESSIONS, chatId);
  if (!session) return sendMessage(env.BOT_TOKEN, chatId, '⚠️ Сначала войди: /login username password');

  try { return await openProjectChoice(env, chatId, session); }
  catch (err) { return sendMessage(env.BOT_TOKEN, chatId, `⚠️ ${err.message}`); }
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
  return sendMessageWithKeyboard(env.BOT_TOKEN, chatId, title, buttons, {}, env);
}

async function cmdSkills(chatId, env) {
  const session = await getSession(env.SESSIONS, chatId);
  if (!session) return sendMessage(env.BOT_TOKEN, chatId, '⚠️ Сначала войди: /login username password');

  let skills;
  try {
    skills = await getSkills(env);
  } catch (e) {
    return sendMessage(env.BOT_TOKEN, chatId, `❌ Не удалось получить список скиллов: ${e.message}`);
  }

  const lines = skills.map(s => {
    const reqLine = s.requires ? `\n   ⚙️ <i>${s.requires}</i>` : '';
    return `<b>${s.name}</b>${reqLine}\n   ${s.description}`;
  });

  return sendMessage(env.BOT_TOKEN, chatId,
    `🛠 <b>Доступные скиллы</b>\n\n${lines.join('\n\n')}\n\n` +
    `<i>Просто напиши задачу — Клод сам выберет нужный скилл.</i>`
  );
}

async function cmdPrivacy(chatId, env) {
  return sendMessage(env.BOT_TOKEN, chatId,
    `🔒 <b>Приватность</b>\n\n` +
    `Сообщения → Claude Code на GCP VM.\n` +
    `Сессии → Cloudflare KV (зашифровано).\n` +
    `Файлы → папка на VM, не передаются третьим сторонам.\n` +
    `Пароли → Cloudflare KV (scrypt hash).\n\n` +
    `Напиши "удали мои данные" — всё будет очищено.`
  );
}

export async function cmdStop(msg, env, action = 'stop', taskId) {
  const chatId = msg.chat.id;
  const session = await getSession(env.SESSIONS, chatId);
  if (!session) return sendMessage(env.BOT_TOKEN, chatId, '⚠️ Сначала войди: /login username password');
  try {
    let sessionId = session.activeSessionId || session.lastSessionId || null;
    if (taskId) {
      const active = await stopTask(env, { username: session.username, chatId, sessionId, taskId, action: 'validate' });
      sessionId = active.sessionId;
    }
    const stub = env.INTAKE?.get(env.INTAKE.idFromName(String(chatId)));
    // Close the intake fence before killing the engine: no buffered auto-launch.
    const paused = stub
      ? await stub.fetch('https://intake/pause', { method: 'POST', body: JSON.stringify({ chatId, sessionId }) }).then(r => r.json()) : null;
    if (action === 'fresh') await stopTask(env, { username: session.username, chatId, sessionId, action: 'stop' });
    const result = await stopTask(env, { username: session.username, chatId, sessionId, action, taskId });
    if (stub && paused) await stub.fetch('https://intake/fence', { method: 'POST', body: JSON.stringify({ generation: paused.generation, epoch: result.epoch, epochs: result.epochs, sessionId }) });
    if (action === 'skip' && stub) {
      await stub.fetch('https://intake/skip-ready', { method: 'POST', body: JSON.stringify({ sessionId, generation: paused.generation }) });
      const r = await stub.fetch('https://intake/flush', { method: 'POST' }).then(r => r.json());
      return sendMessage(env.BOT_TOKEN, chatId, r.empty
        ? '⏭ Текущая работа пропущена. Следующего ввода нет — пришли новую информацию.'
        : '⏭ Перехожу к следующему накопленному вводу в этом диалоге.');
    }
    if (action === 'fresh') {
      if (stub) await stub.fetch('https://intake/fresh', { method: 'POST', body: JSON.stringify({ sessionId }) });
      const id = newSessionId(chatId);
      await setSession(env.SESSIONS, chatId, { ...session, activeSessionId: id, activeSessionIsNew: true,
        lastSessionId: null, contextFromSession: null });
      return sendMessage(env.BOT_TOKEN, chatId, '🆕 Новый запуск будет без незавершённого ввода. История и файлы проекта сохранены.');
    }
    return sendMessage(env.BOT_TOKEN, chatId,
      '⛔ Сессия остановлена, очередь не запускается. Вся полученная информация сохранена — при явном запуске продолжу с ней работать. Другие чаты не затронуты.');
  } catch (e) {
    return sendMessage(env.BOT_TOKEN, chatId, `❌ Остановку не удалось подтвердить: ${e.message}. Накопленный ввод сохранён.`);
  }
}

async function cmdAllOn(msg, env) {
  const { chat } = msg;
  const chatId = chat.id;
  const isGroup = ['group', 'supergroup'].includes(chat.type);

  if (!isGroup) {
    return sendMessage(env.BOT_TOKEN, chatId, '⚠️ Эта команда работает только в группах.');
  }

  const session = await getSession(env.SESSIONS, chatId);
  if (!session) return sendMessage(env.BOT_TOKEN, chatId, '⚠️ Сначала войди: /login username password');

  if (session.allMsgMode) {
    return sendMessage(env.BOT_TOKEN, chatId, '✅ Режим уже включён. Выключить: /all_off');
  }

  const res = await sendMessage(env.BOT_TOKEN, chatId,
    '🔴 <b>Все сообщения → агенту</b>\n\n' +
    'Все сообщения в этой группе автоматически передаются Claude Code.\n\n' +
    'Выключить: /all_off',
    { disable_notification: true }
  );
  const modeMsg = res?.result?.message_id ?? null;
  if (modeMsg) await pinChatMessage(env.BOT_TOKEN, chatId, modeMsg, { silent: true });

  await setSession(env.SESSIONS, chatId, {
    ...session,
    allMsgMode: true,
    allMsgPinnedId: modeMsg,
  });
}

async function cmdAllOff(msg, env) {
  const { chat } = msg;
  const chatId = chat.id;

  const session = await getSession(env.SESSIONS, chatId);
  if (!session) return sendMessage(env.BOT_TOKEN, chatId, '⚠️ Сначала войди: /login username password');

  if (!session.allMsgMode) {
    return sendMessage(env.BOT_TOKEN, chatId, '⚠️ Режим уже выключен.');
  }

  if (session.allMsgPinnedId) {
    await unpinChatMessage(env.BOT_TOKEN, chatId, session.allMsgPinnedId);
    await deleteMessage(env.BOT_TOKEN, chatId, session.allMsgPinnedId);
  }

  if (session.pinnedMsgId) {
    await pinChatMessage(env.BOT_TOKEN, chatId, session.pinnedMsgId, { silent: true });
  }

  await setSession(env.SESSIONS, chatId, {
    ...session,
    allMsgMode: false,
    allMsgPinnedId: null,
  });

  return sendMessage(env.BOT_TOKEN, chatId,
    '⚪ <b>Режим выключен.</b>\n\nТеперь для обращения к агенту нужен reply или упоминание @.',
    { disable_notification: true }
  );
}
