import { startNewDialog } from '../lib/project-choice.js';
import { sendMessage, sendMessageWithKeyboard, pinChatMessage, unpinChatMessage, deleteMessage } from '../lib/telegram.js';
import { getSession, setSession, deleteSession, newSessionId } from '../lib/kv.js';
import { getUser, listUsernames } from '../lib/kv.js';
import { getAgentHealth, getSessions, getFiles, runTask, getSkills, stopTask, reportBugOrFeature } from '../lib/agent-client.js';
import { verifyPassword } from '../lib/auth.js';
import { setUserToken } from '../lib/agent-client.js';
import { resolveAudience } from '../lib/audience.js';
import { isCommandVisible } from '../lib/command-visibility.js';
import { handleMessage } from './message.js';
import { isProjectSwitch } from '../lib/project-command.js';
import commandsRegistry from '../../commands-registry.json';
import { conversationKey, threadExtra, threadIdOf } from '../conversation-context.js';

// Topic-aware outbound helpers (issue #255): new messages must carry the forum
// topic id; threadExtra() is empty without one (private/non-forum unchanged).
function sendIn(env, chatId, threadId, text, extra = {}) {
  return sendMessage(env.BOT_TOKEN, chatId, text, { ...extra, ...threadExtra(threadId) });
}
function sendKbIn(env, chatId, threadId, text, keyboard, extra = {}, lifecycleEnv = env) {
  return sendMessageWithKeyboard(env.BOT_TOKEN, chatId, text, keyboard, { ...extra, ...threadExtra(threadId) }, lifecycleEnv);
}

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

// After the agent switched/pinned the chat's project, drop the gateway's cached
// project + dialog pointers (#1318). Otherwise continuation matching keeps looking
// among the OLD project's sessions; with them cleared, the next message starts a new
// dialog resolved via /project-decision, which returns the newly pinned project.
export async function resetChatProject(env, chatId, threadId = null) {
  const session = await getSession(env.SESSIONS, chatId, threadId);
  if (!session) return;
  await setSession(env.SESSIONS, chatId, { ...session,
    projectId: null, projectPicked: false, lastSessionId: null,
    activeSessionId: null, activeSessionIsNew: false, projectSelectionSessionId: null,
    pendingNewProject: false, contextFromSession: null }, threadId);
}

export async function handleCommand(msg, env) {
  const { chat, text, from } = msg;
  const chatId = chat.id;
  const cmd = text.split(' ')[0].split('@')[0]; // strip @botname
  const threadId = threadIdOf(msg);

  // Agent-side commands (e.g. /persona) are handled downstream in the agent, not here.
  // Forward the raw message so the agent's task pipeline sees the full text + args.
  if (AGENT_FORWARDED_COMMANDS.has(cmd.toLowerCase())) {
    // Convenience: set the role by REPLYING to a message with just `/persona`.
    // If there's no inline arg (and it isn't a control word), lift the replied-to
    // message's text/caption in as the role body, so users don't retype paragraphs.
    const inline = text.slice(cmd.length).trim();
    const quoted = (msg.reply_to_message?.text || msg.reply_to_message?.caption || '').trim();
    const forwarded = quoted && !inline ? { ...msg, text: `${cmd} ${quoted}` } : msg;
    const result = await handleMessage(forwarded, env);
    if (isProjectSwitch(forwarded.text)) await resetChatProject(env, chatId, threadIdOf(forwarded));
    return result;
  }

  switch (cmd) {
    case '/restart': return cmdRestart(msg, env);
    case '/start':   return cmdStart(chatId, env, threadId);
    case '/login':   return cmdLogin(msg, env);
    case '/logout':   return cmdLogout(chatId, env, threadId);
    case '/profile':  return cmdProfile(chatId, env, threadId);
    case '/status':  return cmdStatus(chatId, env, threadId);
    case '/version': return cmdVersion(chatId, env, threadId);
    case '/privacy':          return cmdPrivacy(chatId, env, threadId);
    case '/settoken':          return cmdSetToken(msg, env);
    case '/chromeext_install': return cmdChromeExtInstall(chatId, env, threadId);
    case '/chromeext_connect': return cmdChromeExtConnect(msg, env);
    case '/chromeext_status':  return cmdChromeExtStatus(msg, env);
    case '/sessions':
    case '/диалоги':           return cmdSessions(chatId, env, threadId);
    case '/new_dialog':
    case '/новый_диалог':      return cmdNewDialog(chatId, env, threadId);
    case '/close':
    case '/закрыть':           return cmdClose(chatId, env, threadId);
    case '/files':
    case '/папки':             return cmdFiles(chatId, env, '', threadId);
    case '/ru':                return cmdRu(msg, env);
    case '/стоп':
    case '/stop':              return cmdStop(msg, env);
    case '/clean_buffer':
    case '/очистить_буфер':    return cmdCleanBuffer(chatId, env, threadId);
    case '/clean_up_flood':
    case '/cleanup_flood':
    case '/очистить_флуд':     return cmdCleanUpFlood(msg, env);
    case '/skills':
    case '/скиллы':            return cmdSkills(chatId, env, threadId);
    case '/all_on':            return cmdAllOn(msg, env);
    case '/all_off':           return cmdAllOff(msg, env);
    case '/report':
    case '/report_bug_or_feature_request': return cmdReport(msg, env);
    default:
      // Unified fallback for unregistered commands — `known command → its handler`,
      // `unknown command → agent`. Never reply "unknown command" / treat it as an
      // error: forward the original message (args and all) to the agent as a normal
      // user request, so it can interpret the meaning with its own tool surface.
      // This is deliberately generic (no per-command list, no registry of unknown
      // commands): a missing commands-registry.json entry must never stop a user
      // from reaching the agent, and future commands work without a gateway change.
      return handleMessage(msg, env);
  }
}

async function cmdStart(chatId, env, threadId = null) {
  const session = await getSession(env.SESSIONS, chatId, threadId);
  if (!session) {
    return sendIn(env, chatId, threadId,
      '👋 Привет!\n\nЧтобы начать работу:\n<code>/login username password</code>'
    );
  }
  //
  // Recruiter bot: HH-секция первая (это рабочий домен бота), остальное — поддержка.
  // Сортировка по домену, а не flat list — это то что юзер просил («/start ещё в том боте
  // переписать»). HH_START_COMMANDS hardcoded потому что /new_job_post и /cancel_vacancy
  // HH-adjacent но не начинаются с /hh_; добавлять новые HH-команды — сюда + в реестр.
  //
  // Visibility is decided by the SAME helper the Telegram command menu uses
  // (src/lib/command-visibility.js → registry `audiences`), otherwise /start
  // would list commands the menu itself doesn't show.
  const audience = resolveAudience(env);
  const hhLines = [];
  const otherLines = [];
  const seen = new Set();
  for (const entry of commandsRegistry.commands) {
    if (!isCommandVisible(entry, audience)) continue;
    if (seen.has(entry.command)) continue;
    seen.add(entry.command);
    const aliases = entry.aliases?.length ? ` (${entry.aliases.join(', ')})` : '';
    const line = `<code>${entry.command}</code>${aliases} — ${entry.description}`;
    if (HH_START_COMMANDS.has(entry.command)) {
      hhLines.push(line);
    } else {
      otherLines.push(line);
    }
  }

  // Each audience gets its own one-line self-description; the freelance bot's is a
  // short persona (kept in sync with the agent-side default persona for that audience
  // — src/persona.js AUDIENCE_DEFAULT).
  const intro = audience === 'recruiter'
    ? 'Это бот для работы с HeadHunter и ассистентом.'
    : audience === 'freelance'
      ? 'Я — ассистент по фриланс-проектам: разбираю входящие заказы и файлы, раскладываю их по проектам, считаю риск GO/NO-GO и собираю ТЗ.'
      : 'Это персональный ассистент.';
  const taskHint = audience === 'freelance'
    ? 'Пиши задачу текстом или присылай файлы — сам разберусь.'
    : 'Просто пиши задачи — я передам их агенту.';
  const hhSection = hhLines.length
    ? `<b>🎯 HeadHunter (${hhLines.length}):</b>\n${hhLines.join('\n')}\n\n`
    : '';

  return sendIn(env, chatId, threadId,
    `👋 Привет, ${session.name}!\n\n` +
    `${intro}\n` +
    `${taskHint}\n\n` +
    hhSection +
    `<b>💼 Остальное (${otherLines.length}):</b>\n${otherLines.join('\n')}`
  );
}

// Commands that belong to the HH section in /start. Hardcoded list (not regex on
// command prefix) because /new_job_post and /cancel_vacancy are HH-adjacent but
// don't start with /hh_. New HH commands: add here + to commands-registry.json.
const HH_START_COMMANDS = new Set([
  '/hh_status', '/hh_connect', '/hh_disconnect',
  '/hh_vacancies', '/hh_funnel', '/hh_responses', '/hh_review',
  '/hh_ats', '/hh_evaluate', '/hh_send', '/hh_reject', '/hh_scan',
  '/new_job_post', '/cancel_vacancy',
]);

export async function cmdLogin(msg, env) {
  const threadId = threadIdOf(msg);
  const { chat, text, from } = msg;
  const chatId = chat.id;

  const args = text.trim().split(/\s+/);
  if (args.length < 3) {
    return sendIn(env, chatId, threadId, 'Использование: /login username password');
  }
  const [, username, password] = args;

  const existing = await getSession(env.SESSIONS, chatId, threadId);
  if (existing) {
    return sendIn(env, chatId, threadId,
      `✅ Ты уже вошёл как ${existing.name}. /logout чтобы выйти.`
    );
  }

  const user = await getUser(env.USERS, username);
  if (!user) {
    return sendIn(env, chatId, threadId, '❌ Пользователь не найден.');
  }

  const ok = await verifyPassword(password, user.passwordHash, user.salt);
  if (!ok) {
    return sendIn(env, chatId, threadId, '❌ Неверный пароль.');
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
  }, threadId);
  return sendIn(env, chatId, threadId,
    isGroup
      ? `✅ Добро пожаловать, ${user.name}!\n\n` +
        `Пиши задачи как в личке — я собираю все сообщения и запускаю проработку по кнопке «▶️».\n\n` +
        `Отключить режим «все сообщения → агенту»: <b>/all_off</b>`
      : `✅ Добро пожаловать, ${user.name}!\n\nПросто пиши задачи — я передам их Claude Code.`
  );
}

async function cmdLogout(chatId, env, threadId = null) {
  const session = await getSession(env.SESSIONS, chatId, threadId);
  if (!session) {
    return sendIn(env, chatId, threadId, '⚠️ Ты не авторизован.');
  }
  await deleteSession(env.SESSIONS, chatId);
  return sendIn(env, chatId, threadId,
    `👋 До встречи, ${session.name}! Для входа: /login username password`
  );
}

async function cmdProfile(chatId, env, threadId = null) {
  const session = await getSession(env.SESSIONS, chatId, threadId);
  if (!session) {
    return sendIn(env, chatId, threadId,
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

  return sendKbIn(env, chatId, threadId,
    `👤 <b>Профиль</b>\n\n` +
    `Имя: <b>${session.name}</b>\n` +
    `Логин: <code>${session.username}</code>`,
    buttons, {}, env
  );
}

async function cmdStatus(chatId, env, threadId = null) {
  const session = await getSession(env.SESSIONS, chatId, threadId);
  if (!session) return sendIn(env, chatId, threadId, '⚠️ Ты не авторизован. /login username password');

  const [agentOk, agentRuOk] = await Promise.all([
    getAgentHealth(env),
    env.AGENT_RU_URL ? getAgentHealth({ ...env, AGENT_URL: env.AGENT_RU_URL }) : Promise.resolve(null),
  ]);

  const ruLine = agentRuOk !== null
    ? `\nRU-агент: ${agentRuOk ? '✅ онлайн' : '❌ офлайн'} (nalog.ru, РФ-сервисы)`
    : '';

  return sendIn(env, chatId, threadId,
    `📊 <b>${session.name}</b>\n` +
    `Агент: ${agentOk ? '✅ онлайн' : '❌ офлайн'}` +
    ruLine
  );
}

async function cmdRu(msg, env) {
  const { chat, text } = msg;
  const chatId = chat.id;
  const threadId = threadIdOf(msg);
  const session = await getSession(env.SESSIONS, chatId, threadId);
  if (!session) return sendIn(env, chatId, threadId, '⚠️ Сначала войди: /login username password');

  const task = text.replace(/^\/ru\s*/i, '').trim();
  if (!task) {
    return sendIn(env, chatId, threadId,
      '🇷🇺 <b>Российский IP агент</b>\n\n' +
      'Используй: <code>/ru ваша задача</code>\n\n' +
      'Задачи, переданные через /ru, выполняются на VM с российским IP-адресом.\n' +
      'Нужно для: nalog.ru, gosuslugi.ru и других РФ-сервисов.\n\n' +
      'Пример: <code>/ru проверь мои доходы на nalog.ru</code>'
    );
  }

  if (!env.AGENT_RU_URL) {
    return sendIn(env, chatId, threadId, '❌ RU-агент не настроен.');
  }

  try {
    const sessionId = newSessionId(chatId);
    await runTask(env, {
      initiatedAt: Number.isFinite(msg.date) ? msg.date * 1000 : Date.now(), threadId: msg.message_thread_id || null,
      requestId: `command-${chatId}-${msg.message_id}`,
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
    }, threadId);
  } catch (err) {
    await sendIn(env, chatId, threadId, `❌ Ошибка RU-агента: ${err.message}`);
  }
}

async function cmdVersion(chatId, env, threadId = null) {
  return sendIn(env, chatId, threadId,
    `🤖 <b>Trained Assist Bot</b>\nWorker — Cloudflare\nAgent — GCP VM`
  );
}

async function cmdSetToken(msg, env) {
  const threadId = threadIdOf(msg);
  const { chat, text } = msg;
  const chatId = chat.id;
  const session = await getSession(env.SESSIONS, chatId, threadId);
  if (!session) return sendIn(env, chatId, threadId, '⚠️ Сначала войди: /login username password');

  const args = text.trim().split(/\s+/);
  if (args.length < 3) {
    return sendIn(env, chatId, threadId,
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
    return sendIn(env, chatId, threadId,
      `✅ Токен <b>${label}</b> сохранён. Клод увидит его в следующей задаче.`
    );
  } catch (e) {
    return sendIn(env, chatId, threadId, `❌ Ошибка: ${e.message}`);
  }
}

async function cmdChromeExtConnect(msg, env) {
  const threadId = threadIdOf(msg);
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
    return sendIn(env, chatId, threadId,
      `🔗 <b>Код подключения расширения</b>\n\n` +
      `<code>${code}</code>\n\n` +
      `Действует 10 минут. Введи его в попапе расширения Cloud Auth Bridge → <b>Подключить</b>.\n\n` +
      `Расширение не установлено? → /chromeext_install`
    );
  } catch (e) {
    return sendIn(env, chatId, threadId, `❌ Ошибка генерации кода: ${e.message}`);
  }
}

async function cmdChromeExtStatus(msg, env) {
  const threadId = threadIdOf(msg);
  const chatId = msg.chat.id;
  const userId = msg.from?.id || chatId;
  try {
    const res = await fetch(`${env.RELAY_URL}/status/${userId}`, {
      headers: { 'Authorization': `Bearer ${env.RELAY_BOT_SECRET}` },
    });
    if (!res.ok) throw new Error(`relay ${res.status}`);
    const { connected } = await res.json();
    return sendIn(env, chatId, threadId,
      connected
        ? '✅ Chrome-расширение подключено и активно.'
        : '❌ Расширение не подключено. Используй /chromeext_connect для привязки.'
    );
  } catch (e) {
    return sendIn(env, chatId, threadId, `❌ Ошибка проверки статуса: ${e.message}`);
  }
}

async function cmdChromeExtInstall(chatId, env, threadId = null) {
  return sendIn(env, chatId, threadId,
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
  const threadId = threadIdOf(msg);
  const { chat, text } = msg;
  const chatId = chat.id;
  const session = await getSession(env.SESSIONS, chatId, threadId);
  if (!session) return sendIn(env, chatId, threadId, '⚠️ Сначала войди: /login username password');

  const description = text.replace(/^\/report(_bug_or_feature_request)?\s*/i, '').trim();
  if (!description) {
    return sendIn(env, chatId, threadId,
      '🐛 <b>Сообщить о баге или предложить фичу</b>\n\n' +
      'Использование:\n' +
      '<code>/report описание проблемы или идеи</code>\n\n' +
      'Примеры:\n' +
      '<code>/report при отправке файла бот зависает</code>\n' +
      '<code>/report хочу чтобы можно было скачивать сессии в PDF</code>'
    );
  }

  await sendIn(env, chatId, threadId, '📤 Создаю issue...');

  try {
    const result = await reportBugOrFeature(env, {
      username: session.username,
      description,
      sessionId: session.activeSessionId || session.lastSessionId || undefined,
    });
    return sendIn(env, chatId, threadId,
      `✅ <b>Issue создан!</b>\n\n` +
      `<b>#${result.number}</b> ${description.slice(0, 60)}${description.length > 60 ? '…' : ''}\n\n` +
      `<a href="${result.url}">Открыть в GitHub</a>`
    );
  } catch (e) {
    return sendIn(env, chatId, threadId, `❌ Не удалось создать issue: ${e.message}`);
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
  }, threadId);
  const numBtns = list.map((s, i) => ({ text: String(i + 1), callback_data: `${callbackPrefix}:${s.id}` }));
  const rows = [];
  for (let i = 0; i < numBtns.length; i += 5) rows.push(numBtns.slice(i, i + 5));
  return { text: lines.join('\n').trim(), buttons: rows };
}

async function cmdSessions(chatId, env, threadId = null) {
  const session = await getSession(env.SESSIONS, chatId, threadId);
  if (!session) return sendIn(env, chatId, threadId, '⚠️ Сначала войди: /login username password');

  let list;
  try {
    list = await getSessions(env, { username: session.username, limit: 8 });
  } catch (e) {
    return sendIn(env, chatId, threadId, `❌ Не удалось получить диалоги: ${e.message}`);
  }

  if (!list || list.length === 0) {
    return sendIn(env, chatId, threadId,
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

  return sendKbIn(env, chatId, threadId, text, buttons, {}, env);
}

async function cmdClose(chatId, env, threadId = null) {
  const session = await getSession(env.SESSIONS, chatId, threadId);
  if (!session) return sendIn(env, chatId, threadId, '⚠️ Сначала войди: /login username password');

  await setSession(env.SESSIONS, chatId, {
    ...session,
    activeSessionId: null,
    activeSessionIsNew: false,
    projectSelectionSessionId: null,
    projectPicked: false,
    pendingNewProject: false,
    pendingProjectChoice: session.pendingProjectChoice ? { ...session.pendingProjectChoice, suspended: true } : null,
    lastSessionId: null,
    pendingMessage: null,
    pendingMessageAt: null,
    contextFromSession: null,
  }, threadId);
  return sendIn(env, chatId, threadId,
    '🔚 <b>Диалог закрыт.</b>\n\nСледующее сообщение начнёт новый диалог с чистого листа.'
  );
}

async function cmdNewDialog(chatId, env, threadId = null) {
  const session = await getSession(env.SESSIONS, chatId, threadId);
  if (!session) return sendIn(env, chatId, threadId, '⚠️ Сначала войди: /login username password');

  try { return await startNewDialog(env, chatId, session, { threadId }); }
  catch (err) { return sendIn(env, chatId, threadId, `⚠️ ${err.message}`); }
}

export async function cmdFiles(chatId, env, relPath = '', threadId = null) {
  const session = await getSession(env.SESSIONS, chatId, threadId);
  if (!session) return sendIn(env, chatId, threadId, '⚠️ Сначала войди: /login username password');

  let data;
  try {
    data = await getFiles(env, { username: session.username, path: relPath });
  } catch (e) {
    return sendIn(env, chatId, threadId, `❌ Ошибка: ${e.message}`);
  }

  const { entries, path: currentPath } = data;

  if (!entries || entries.length === 0) {
    return sendIn(env, chatId, threadId, `📂 <code>${currentPath || '/'}</code>\n\n(пусто)`);
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
  return sendKbIn(env, chatId, threadId, title, buttons, {}, env);
}

async function cmdSkills(chatId, env, threadId = null) {
  const session = await getSession(env.SESSIONS, chatId, threadId);
  if (!session) return sendIn(env, chatId, threadId, '⚠️ Сначала войди: /login username password');

  let skills;
  try {
    skills = await getSkills(env);
  } catch (e) {
    return sendIn(env, chatId, threadId, `❌ Не удалось получить список скиллов: ${e.message}`);
  }

  const lines = skills.map(s => {
    const reqLine = s.requires ? `\n   ⚙️ <i>${s.requires}</i>` : '';
    return `<b>${s.name}</b>${reqLine}\n   ${s.description}`;
  });

  return sendIn(env, chatId, threadId,
    `🛠 <b>Доступные скиллы</b>\n\n${lines.join('\n\n')}\n\n` +
    `<i>Просто напиши задачу — Клод сам выберет нужный скилл.</i>`
  );
}

async function cmdPrivacy(chatId, env, threadId = null) {
  return sendIn(env, chatId, threadId,
    `🔒 <b>Приватность</b>\n\n` +
    `Сообщения → Claude Code на GCP VM.\n` +
    `Сессии → Cloudflare KV (зашифровано).\n` +
    `Файлы → папка на VM, не передаются третьим сторонам.\n` +
    `Пароли → Cloudflare KV (scrypt hash).\n\n` +
    `Напиши "удали мои данные" — всё будет очищено.`
  );
}

// Escape hatch for a stuck intake buffer: drop buffered/retry/failed batches and
// any pending debounce for THIS chat, without touching an in-flight run. A batch
// that can't be prepared/prepared-checked leaves messages sitting with no button
// and no ack — this lets the user unblock themselves instead of contacting support.
async function cmdCleanBuffer(chatId, env, threadId = null) {
  if (!env.INTAKE) return sendIn(env, chatId, threadId, '⚠️ Буфер недоступен в этом окружении.');
  try {
    const stub = env.INTAKE.get(env.INTAKE.idFromName(conversationKey(chatId, threadId)));
    const res = await stub.fetch('https://intake/clear', { method: 'POST', body: JSON.stringify({}) });
    const data = await res.json().catch(() => ({}));
    if (data.busy) {
      return sendIn(env, chatId, threadId, '⏳ Сейчас идёт задача — буфер очищу после её завершения. Повтори /clean_buffer позже.');
    }
    const parts = [`🧹 Буфер очищен: снято сообщений — ${data.cleared ?? 0}`];
    if (data.failed) parts.push(`сбоев — ${data.failed}`);
    return sendIn(env, chatId, threadId, parts.join(', ') + '. Можно отправлять задачу заново.');
  } catch (e) {
    return sendIn(env, chatId, threadId, `❌ Не удалось очистить буфер: ${e.message}`);
  }
}

// Delete many messages (Telegram deleteMessages, ≤100/call) with a per-id
// deleteMessage fallback. Local to this handler so it doesn't add a named export
// every test that mocks lib/telegram.js would have to declare.
async function deleteManyMessages(token, chatId, ids) {
  const list = ids.filter((n) => Number.isInteger(n));
  let deleted = 0;
  for (let i = 0; i < list.length; i += 100) {
    const batch = list.slice(i, i + 100);
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/deleteMessages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_ids: batch }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok !== false) { deleted += batch.length; continue; }
    } catch { /* fall through to per-id */ }
    for (const id of batch) {
      try {
        const r = await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, message_id: id }),
        });
        const d = await r.json().catch(() => ({}));
        if (r.ok && d.ok !== false) deleted += 1;
      } catch { /* count as failed */ }
    }
  }
  return { deleted, failed: list.length - deleted };
}

// Delete the bot's own TEXT messages in this chat: the agent deletes the text it
// sent (streamed answers, context cards, notifications); the gateway deletes the
// text it sent (collectors, notices) recorded under `sent:<chatId>` in KV. File
// artifacts (documents/photos) are never tracked, so they survive. Telegram only
// lets a bot delete its own messages <48h old, and in groups only with
// can_delete_messages — failures are reported, not hidden.
async function cmdCleanUpFlood(msg, env) {
  const threadId = threadIdOf(msg);
  const chatId = msg.chat.id;
  const session = await getSession(env.SESSIONS, chatId, threadId);
  if (!session) return sendIn(env, chatId, threadId, '⚠️ Сначала войди: /login username password');

  // Agent side — don't block the gateway cleanup if it's down.
  let agent = null;
  try {
    const res = await fetch(`${env.AGENT_URL}/cleanup-flood`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.AGENT_SECRET}` },
      body: JSON.stringify({ chatId, audience: resolveAudience(env) }),
      signal: AbortSignal.timeout(30000),
    });
    if (res.ok) agent = await res.json();
    else console.warn(`[cleanup] agent /cleanup-flood HTTP ${res.status}`);
  } catch (e) { console.warn('[cleanup] agent cleanup failed:', e.message); }

  // Gateway side — its own recorded text messages.
  let ids = [];
  try {
    const raw = env.SESSIONS ? await env.SESSIONS.get(`sent:${chatId}`) : null;
    ids = raw ? JSON.parse(raw) : [];
  } catch { ids = []; }
  const bot = ids.length ? await deleteManyMessages(env.BOT_TOKEN, chatId, ids) : { deleted: 0, failed: 0 };
  try { if (env.SESSIONS) await env.SESSIONS.delete(`sent:${chatId}`); } catch { /* ignore */ }

  const deleted = (agent?.deleted || 0) + bot.deleted;
  const failed = (agent?.failed || 0) + bot.failed;
  const agentNote = agent ? '' : '\n\n<i>Агент был недоступен — часть его сообщений могла остаться.</i>';
  return sendIn(env, chatId, threadId,
    `🧹 <b>Очистка</b>\n\n` +
    `Удалил: <b>${deleted}</b>\n` +
    `Не смог: <b>${failed}</b>\n\n` +
    `Файлы (документы, фото) не трогал. Telegram не даёт удалять свои сообщения старше 48ч, а в группах — без прав на удаление.${agentNote}`
  );
}

async function cmdStop(msg, env) {
  const threadId = threadIdOf(msg);
  const { chat } = msg;
  const chatId = chat.id;
  const session = await getSession(env.SESSIONS, chatId, threadId);
  if (!session) return sendIn(env, chatId, threadId, '⚠️ Сначала войди: /login username password');

  try {
    const result = await stopTask(env, { username: session.username, chatId, threadId });
    if (result.killed > 0) {
      return sendIn(env, chatId, threadId, '🛑 Задача остановлена.');
    } else {
      return sendIn(env, chatId, threadId, '🤷 Нет активных задач для остановки.');
    }
  } catch (e) {
    return sendIn(env, chatId, threadId, `❌ Ошибка: ${e.message}`);
  }
}

async function cmdAllOn(msg, env) {
  const threadId = threadIdOf(msg);
  const { chat } = msg;
  const chatId = chat.id;
  const isGroup = ['group', 'supergroup'].includes(chat.type);

  if (!isGroup) {
    return sendIn(env, chatId, threadId, '⚠️ Эта команда работает только в группах.');
  }

  const session = await getSession(env.SESSIONS, chatId, threadId);
  if (!session) return sendIn(env, chatId, threadId, '⚠️ Сначала войди: /login username password');

  if (session.allMsgMode) {
    return sendIn(env, chatId, threadId, '✅ Режим уже включён. Выключить: /all_off');
  }

  const res = await sendIn(env, chatId, threadId,
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
  }, threadId);
}

async function cmdAllOff(msg, env) {
  const threadId = threadIdOf(msg);
  const { chat } = msg;
  const chatId = chat.id;

  const session = await getSession(env.SESSIONS, chatId, threadId);
  if (!session) return sendIn(env, chatId, threadId, '⚠️ Сначала войди: /login username password');

  if (!session.allMsgMode) {
    return sendIn(env, chatId, threadId, '⚠️ Режим уже выключен.');
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
  }, threadId);

  return sendIn(env, chatId, threadId,
    '⚪ <b>Режим выключен.</b>\n\nТеперь для обращения к агенту нужен reply или упоминание @.',
    { disable_notification: true }
  );
}

// Hidden from /start and setMyCommands, deliberately available to all logged-in users.
async function cmdRestart(msg, env) {
  const threadId = threadIdOf(msg);
  const session = await getSession(env.SESSIONS, msg.chat.id, threadId);
  if (!session) return sendIn(env, msg.chat.id, threadId, 'Сначала войди через /login.');
  const arg = msg.text.trim().split(/\s+/)[1] || '';
  if (!['', 'status', 'cancel'].includes(arg)) return sendIn(env, msg.chat.id, threadId, '/restart, /restart status или /restart cancel');
  try {
    const res = await fetch(`${env.AGENT_URL}/maintenance`, {
      method: arg === 'status' ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${env.AGENT_SECRET}`, 'Content-Type': 'application/json' },
      ...(arg === 'status' ? {} : { body: JSON.stringify({ action: arg === 'cancel' ? 'cancel' : 'request', initiator: { username: session.username, chatId: msg.chat.id, threadId: msg.message_thread_id || null } }) }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw Error(`HTTP ${res.status}`);
    const state = await res.json();
    // The agent restarts instantly and resumes interrupted tasks by itself: nothing is paused or queued.
    const text = state.phase === 'restarting' ? '🔄 Перезапускаюсь. Прерванные задачи продолжатся сами.' : '✅ Сервер работает.';
    return sendIn(env, msg.chat.id, threadId, text);
  } catch (e) {
    return sendIn(env, msg.chat.id, threadId, `Не удалось получить подтверждение рестарта (${e.message}). Проверь /restart status.`);
  }
}
