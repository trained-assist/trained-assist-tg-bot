const fs = require('fs');
const path = require('path');
const { Telegraf } = require('telegraf');
const axios = require('axios');
const { AuthManager, MODE } = require('./auth');
const { SessionManager } = require('./sessions');
const { loadSecrets } = require('./secrets');
const { getUserByChatId } = require('./users');
const { routeMessage } = require('./router');
const { runTask } = require('./runner');
const { ProfileManager } = require('./profile');
const { createServer: createLogServer } = require('./log-server');

const CF_LOG = '/tmp/cf-tunnel.log';
const profiles = new ProfileManager();

const ADMIN_USER_ID = 1714048;        // Vladimir — личный чат
const ADMIN_GROUP_ID = -5308931318;   // super assistant admin group

// pendingRoutes tracks users waiting for session selection via inline keyboard.
// Map<userId, { text, imageFilePath?, sessions }>
const pendingRoutes = new Map();


function getTunnelUrl() {
  try {
    return fs.readFileSync(CF_LOG, 'utf8')
      .match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0] ?? null;
  } catch { return null; }
}

// ── Session-routing inline keyboard ─────────────────────────────────────────

function buildRouteKeyboard(sessions) {
  const rows = sessions.slice(0, 4).map(([name, s]) => [{
    text: `▶ ${s.summary || s.taskDescription.slice(0, 40)}`,
    callback_data: `route:continue:${name}`,
  }]);
  rows.push([{ text: '➕ Новая сессия', callback_data: 'route:new' }]);
  return { inline_keyboard: rows };
}

// ── Sessions-list inline keyboard ───────────────────────────────────────────

function buildSessionsKeyboard(sessions) {
  if (!sessions.length) return null;
  const rows = sessions.map(([name, s]) => [
    { text: `▶ ${s.summary.slice(0, 30)}`, callback_data: `sess:cont:${name}` },
    { text: '🗑', callback_data: `sess:arch:${name}` },
  ]);
  return { inline_keyboard: rows };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const secrets = await loadSecrets().catch(err => {
    console.error('Failed to load secrets:', err.message);
    process.exit(1);
  });

  const { TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, DEEPGRAM_API_KEY, AUTH_SYNC_URL, AUTH_SYNC_SECRET } = secrets;

  const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

  const auth = new AuthManager({
    bot,
    apiKey: ANTHROPIC_API_KEY,
    authSyncUrl: AUTH_SYNC_URL,
    authSyncSecret: AUTH_SYNC_SECRET,
    chatId: ADMIN_GROUP_ID,   // auth уведомления → группа
    onAuthRestored: (m) => {
      bot.telegram.sendMessage(ADMIN_GROUP_ID,
        `♻️ Auth восстановлен. Режим: ${m === MODE.APIKEY ? 'API Key 💳' : 'OAuth 👤'}`);
    },
  });

  const sessions = new SessionManager({ authManager: auth, bot });

  // ── Middleware: guard ──────────────────────────────────────────────────────

  bot.use((ctx, next) => {
    const chatId = ctx.chat?.id;

    // Группа — принимаем ТОЛЬКО /reauth, всё остальное игнорируем
    if (chatId === ADMIN_GROUP_ID) {
      const text = ctx.message?.text || '';
      if (text.startsWith('/reauth')) return next();
      return; // тишина
    }

    // Личные чаты — проверяем регистрацию
    const user = getUserByChatId(chatId);
    if (!user) {
      console.log(`UNKNOWN_USER chat_id=${chatId} @${ctx.from?.username}`);
      return;
    }
    ctx.alesakUser = user;
    sessions.setUserRef(user);
    return next();
  });

  // ── /start ─────────────────────────────────────────────────────────────────

  bot.command('start', (ctx) => {
    ctx.reply(
      `👋 Привет, ${ctx.alesakUser.name}!\n\n` +
      `Просто пиши задачи — я запущу Claude Code и верну результат.\n\n` +
      `Команды:\n/sessions — управление сессиями\n/me — твой профиль\n/terminal — веб-терминал\n/status — текущий статус\n/version — версия бота\n/privacy — как хранятся твои данные`
    );
  });

  // ── /status ────────────────────────────────────────────────────────────────

  bot.command('status', (ctx) => {
    const user = ctx.alesakUser;
    const modeLabel = auth.currentMode() === MODE.APIKEY ? '💳 API Key' : '👤 OAuth';
    const list = sessions.list(user.id);
    const sessionLines = list.length
      ? list.map(([n, s]) => `• ${s.summary.slice(0, 50)}`).join('\n')
      : '• нет активных сессий';
    ctx.reply(`📊 *${user.name}*\nAuth: ${modeLabel}\n\nСессии:\n${sessionLines}`, { parse_mode: 'Markdown' });
  });

  // ── /sessions ──────────────────────────────────────────────────────────────

  bot.command('sessions', (ctx) => {
    const user = ctx.alesakUser;
    const list = sessions.list(user.id);
    if (!list.length) return ctx.reply('Нет активных сессий. Просто напиши задачу — запущу.');
    ctx.reply(
      `📋 *Твои сессии* (${list.length}):\n\n` +
      list.map(([, s], i) => `${i + 1}. ${s.summary}`).join('\n'),
      {
        parse_mode: 'Markdown',
        reply_markup: buildSessionsKeyboard(list),
      }
    );
  });

  // ── /me ────────────────────────────────────────────────────────────────────

  bot.command('me', (ctx) => {
    const user = ctx.alesakUser;
    const profile = profiles.load(user);
    ctx.reply(
      profiles.formatForDisplay(profile) + '\n\n_Чтобы обновить: /setabout текст или /setprefs текст_',
      { parse_mode: 'Markdown' }
    );
  });

  bot.command('setabout', (ctx) => {
    const user = ctx.alesakUser;
    const text = ctx.message.text.replace(/^\/setabout\s*/, '').trim();
    if (!text) return ctx.reply('Пример: /setabout CEO стартапа, работаю в SaaS, интересуюсь AI');
    const profile = profiles.load(user);
    profiles.save(user, { ...profile, about: text });
    ctx.reply('✅ Профиль обновлён.');
  });

  bot.command('setprefs', (ctx) => {
    const user = ctx.alesakUser;
    const text = ctx.message.text.replace(/^\/setprefs\s*/, '').trim();
    if (!text) return ctx.reply('Пример: /setprefs отвечай кратко, без лишних объяснений');
    const profile = profiles.load(user);
    profiles.save(user, { ...profile, preferences: text });
    ctx.reply('✅ Предпочтения сохранены.');
  });

  // ── /version ───────────────────────────────────────────────────────────────

  const BOOT_TIME = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const GIT_HASH = (() => {
    try { return require('child_process').execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim(); }
    catch { return 'unknown'; }
  })();

  bot.command('version', (ctx) => {
    ctx.reply(
      `🤖 *Alesa*\n` +
      `Commit: \`${GIT_HASH}\`\n` +
      `Запущен: ${BOOT_TIME} UTC\n` +
      `Auth: ${auth.currentMode() === MODE.APIKEY ? '💳 API Key' : '👤 OAuth'}`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── /privacy ───────────────────────────────────────────────────────────────

  bot.command('privacy', (ctx) => {
    ctx.reply(
      `🔒 *Как Алеса работает с твоими данными*\n\n` +
      `*Сообщения и задачи*\n` +
      `Каждый запрос обрабатывается Claude AI. Краткий контекст (последний вопрос + ответ) сохраняется для продолжения разговора. Полная история не хранится.\n\n` +
      `*Файлы и фото*\n` +
      `Загруженные файлы сохраняются временно в защищённой папке на сервере. После обработки и экспорта — удаляются. Если файл содержит много личных данных (телефоны, адреса), бот об этом предупредит.\n\n` +
      `*Токены, пароли, карты*\n` +
      `Если ты передал мне credentials — они сохраняются в GCP Secret Manager (шифрование AES-256). Я могу *использовать* их для задач, но *не вижу* значение напрямую и не смогу воспроизвести его тебе в чате. Не удаляй их сам — иначе я потеряю доступ.\n\n` +
      `*Ссылки и ID документов*\n` +
      `Google Sheet / Doc ID сохраняются в изолированной папке на сервере, недоступной извне и не попадающей в git.\n\n` +
      `*Удаление данных*\n` +
      `Напиши _"удали мои данные"_ — Алеса очистит профиль, файлы и saved credentials.`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── /terminal ──────────────────────────────────────────────────────────────

  bot.command('terminal', (ctx) => {
    const tunnelUrl = getTunnelUrl();
    if (!tunnelUrl) return ctx.reply('Туннель ещё не готов, подожди 10–15 с.');
    ctx.reply('🖥 Веб-терминал (alesa / alesa123):', {
      reply_markup: { inline_keyboard: [[{ text: '🔗 Открыть', url: tunnelUrl }]] },
    });
  });

  // ── /reauth ────────────────────────────────────────────────────────────────
  // Запускаем без await — иначе блокируем Telegraf polling на 5 мин и получаем crash

  bot.command('reauth', (ctx) => {
    ctx.reply('🔄 Запускаю OAuth…');
    auth.forceReauth(); // fire-and-forget
  });

  // ── Callback queries (inline keyboard actions) ─────────────────────────────

  bot.on('callback_query', async (ctx) => {
    await ctx.answerCbQuery();
    const user = ctx.alesakUser;
    const data = ctx.callbackQuery.data;

    // ── Session routing callbacks ──────────────────────────────────────────

    if (data === 'route:new') {
      const pending = pendingRoutes.get(user.id);
      if (!pending) return;
      pendingRoutes.delete(user.id);
      await ctx.editMessageText('➕ Запускаю новую сессию…');
      const taskText = pending.text;
      _enqueueThunk(user, async () => {
        const profile = profiles.load(user);
        const context = profiles.toContext(profile, user.workDir);
        const sessionName = await sessions.create(user, taskText);
        await runTask({ user, task: taskText, authManager: auth, telegram: bot.telegram, chatId: user.id, context });
        await bot.telegram.sendMessage(user.id, `✅ Сессия: \`${sessionName}\``, { parse_mode: 'Markdown' });
      });
      return;
    }

    if (data.startsWith('route:continue:')) {
      const sessionName = data.slice('route:continue:'.length);
      const pending = pendingRoutes.get(user.id);
      if (!pending) return;
      pendingRoutes.delete(user.id);
      await ctx.editMessageText(`▶ Продолжаю…`);
      const taskText = pending.text;
      _enqueueThunk(user, async () => {
        const sessData = sessions.list(user.id).find(([n]) => n === sessionName)?.[1];
        const profile = profiles.load(user);
        const contextParts = [profiles.toContext(profile)].filter(Boolean);
        if (sessData?.taskDescription) {
          contextParts.push(`[Контекст предыдущего разговора: ${sessData.taskDescription.slice(0, 300)}]`);
        }
        const context = contextParts.join('\n\n') || null;
        await runTask({ user, task: taskText, authManager: auth, telegram: bot.telegram, chatId: user.id, context });
      });
      return;
    }

    // ── Sessions list callbacks ────────────────────────────────────────────

    if (data.startsWith('sess:arch:')) {
      const sessionName = data.slice('sess:arch:'.length);
      sessions.archive(user.id, sessionName);
      const list = sessions.list(user.id);
      if (!list.length) {
        await ctx.editMessageText('🗑 Сессия закрыта. Нет активных сессий.');
      } else {
        await ctx.editMessageText(
          `📋 *Твои сессии* (${list.length}):\n\n` +
          list.map(([, s], i) => `${i + 1}. ${s.summary}`).join('\n'),
          { parse_mode: 'Markdown', reply_markup: buildSessionsKeyboard(list) }
        );
      }
      return;
    }

    if (data.startsWith('sess:cont:')) {
      const sessionName = data.slice('sess:cont:'.length);
      await ctx.editMessageText(`▶ Отправь следующее сообщение — оно пойдёт в эту сессию`);
      // Mark this session as the active target for next message
      pendingRoutes.set(user.id, { pinned: sessionName });
      return;
    }
  });

  // ── Helper: dispatch a text or voice task through the routing logic ────────

  // Track active (in-flight) runTask calls for graceful shutdown.
  // Map<userId, { chatId, startedAt, text }>
  const activeTasks = new Map();

  // Build context string from session history for Claude.
  function buildSessionContext(user, sessData) {
    const profile = profiles.load(user);
    const parts = [profiles.toContext(profile, user.workDir)].filter(Boolean);
    if (!sessData) return parts.join('\n\n') || null;

    let history = `[Тема разговора: ${sessData.taskDescription.slice(0, 300)}]`;
    if (sessData.lastQuestion) {
      history += `\n[Последний вопрос пользователя: ${sessData.lastQuestion.slice(0, 300)}]`;
    }
    if (sessData.lastResponse) {
      history += `\n[Последний ответ ассистента:\n${sessData.lastResponse.slice(-600)}]`;
    }
    parts.push(history);
    return parts.join('\n\n') || null;
  }

  // Save Q&A to session data after a successful runTask.
  function saveExchange(userId, sessionName, question, result) {
    if (!result) return;
    const sessData = sessions.list(userId).find(([n]) => n === sessionName)?.[1];
    if (!sessData) return;
    sessData.lastQuestion = question.slice(0, 300);
    sessData.lastResponse = result.slice(-600);
    sessData.lastMessageAt = Date.now();
    sessions.persist();
  }

  async function handleTask(user, text, chatId, imageFilePath) {
    activeTasks.set(user.id, { chatId, startedAt: Date.now(), text: text.slice(0, 60) });
    try {
      // If user has a pinned session target (from sess:cont button)
      const pending = pendingRoutes.get(user.id);
      if (pending?.pinned) {
        pendingRoutes.delete(user.id);
        const sessionName = pending.pinned;
        const fullText = imageFilePath ? `${text}\n\n[Изображение: ${imageFilePath}]` : text;
        const sessData = sessions.list(user.id).find(([n]) => n === sessionName)?.[1];
        const context = buildSessionContext(user, sessData);
        const result = await runTask({ user, task: fullText, authManager: auth, telegram: bot.telegram, chatId, context, filesToCleanup: imageFilePath ? [imageFilePath] : [] });
        saveExchange(user.id, sessionName, text, result);
        return;
      }

      const list = sessions.list(user.id);
      const route = await routeMessage({ text, sessions: list, apiKey: ANTHROPIC_API_KEY });

      if (route.action === 'new') {
        const fullText = imageFilePath ? `${text}\n\n[Изображение сохранено в: ${imageFilePath}]` : text;
        const sessionName = await sessions.create(user, fullText);
        const context = buildSessionContext(user, null);
        const result = await runTask({ user, task: fullText, authManager: auth, telegram: bot.telegram, chatId, context, filesToCleanup: imageFilePath ? [imageFilePath] : [] });
        saveExchange(user.id, sessionName, text, result);
        await bot.telegram.sendMessage(chatId, `📁 Сессия: \`${sessionName}\``, { parse_mode: 'Markdown' });
        return;
      }

      if (route.action === 'continue') {
        const sessionName = route.sessionName;
        const fullText = imageFilePath ? `${text}\n\n[Изображение: ${imageFilePath}]` : text;
        const sessData = sessions.list(user.id).find(([n]) => n === sessionName)?.[1];
        const context = buildSessionContext(user, sessData);
        const result = await runTask({ user, task: fullText, authManager: auth, telegram: bot.telegram, chatId, context, filesToCleanup: imageFilePath ? [imageFilePath] : [] });
        saveExchange(user.id, sessionName, text, result);
        return;
      }

      if (route.action === 'ask') {
        pendingRoutes.set(user.id, { text, imageFilePath, sessions: route.sessions || list });
        const sessionList = (route.sessions || list);
        return bot.telegram.sendMessage(chatId,
          `🤔 Продолжить существующую сессию или начать новую?\n\n` +
          sessionList.slice(0, 4).map(([, s], i) => `${i + 1}. ${s.summary}`).join('\n'),
          { reply_markup: buildRouteKeyboard(sessionList) }
        );
      }
    } finally {
      activeTasks.delete(user.id);
    }
  }

  // ── Per-user task queue ────────────────────────────────────────────────────

  const userQueues = new Map();

  function enqueueTask(user, text, chatId, imageFilePath) {
    _enqueueThunk(user, () => handleTask(user, text, chatId, imageFilePath));
  }

  function _enqueueThunk(user, thunk) {
    if (!userQueues.has(user.id)) userQueues.set(user.id, { running: false, items: [] });
    const q = userQueues.get(user.id);
    q.items.push(thunk);
    if (!q.running) _drainQueue(user);
  }

  async function _drainQueue(user) {
    const q = userQueues.get(user.id);
    if (!q || q.running) return;
    q.running = true;
    while (q.items.length > 0) {
      const thunk = q.items.shift();
      try { await thunk(); } catch (e) { console.error('queue task error:', e); }
    }
    q.running = false;
  }

  // ── Text handler ───────────────────────────────────────────────────────────

  bot.on('text', async (ctx) => {
    if (ctx.message.text.startsWith('/')) return;
    const text = ctx.message.text.trim();

    // If auth is waiting for the user to paste a verification code — intercept
    if (auth.hasPendingCode()) {
      auth.receiveCode(text);
      return ctx.reply('🔑 Код отправлен, авторизую…');
    }

    enqueueTask(ctx.alesakUser, text, ctx.chat.id, null);
  });

  // ── Voice handler ──────────────────────────────────────────────────────────

  bot.on('voice', async (ctx) => {
    const user = ctx.alesakUser;
    const fileLink = await ctx.telegram.getFileLink(ctx.message.voice.file_id);
    const { data: buf } = await axios.get(fileLink.href, { responseType: 'arraybuffer' });

    const dg = await axios.post(
      'https://api.deepgram.com/v1/listen?model=nova-2&language=ru&smart_format=true',
      buf,
      { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}`, 'Content-Type': 'audio/ogg' } }
    );

    const transcript = dg.data?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
    if (!transcript) return ctx.reply('Не удалось распознать голос.');

    await ctx.reply(`📝 _${transcript}_`, { parse_mode: 'Markdown' });
    enqueueTask(user, transcript, ctx.chat.id, null);
  });

  // ── Photo handler ──────────────────────────────────────────────────────────

  bot.on('photo', async (ctx) => {
    const user = ctx.alesakUser;
    const caption = ctx.message.caption || 'Посмотри на это изображение и опиши что на нём.';

    // Get the highest-resolution photo
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const fileLink = await ctx.telegram.getFileLink(photo.file_id);
    const { data: imgBuf } = await axios.get(fileLink.href, { responseType: 'arraybuffer' });

    // Save to user's workDir so Claude can read it
    fs.mkdirSync(user.workDir, { recursive: true });
    const imgFile = path.join(user.workDir, `img-${Date.now()}.jpg`);
    fs.writeFileSync(imgFile, imgBuf);

    await ctx.reply(`🖼 Изображение сохранено. Обрабатываю…`);
    enqueueTask(user, caption, ctx.chat.id, imgFile);
  });

  // ── Document handler ───────────────────────────────────────────────────────

  bot.on('document', async (ctx) => {
    const user = ctx.alesakUser;
    const doc = ctx.message.document;
    const caption = ctx.message.caption || `Посмотри на файл ${doc.file_name} и обработай его.`;

    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    const { data: buf } = await axios.get(fileLink.href, { responseType: 'arraybuffer' });

    fs.mkdirSync(user.workDir, { recursive: true });
    const filePath = path.join(user.workDir, doc.file_name || `file-${Date.now()}`);
    fs.writeFileSync(filePath, buf);

    await ctx.reply(`📎 Файл сохранён: ${doc.file_name}`);
    enqueueTask(user, caption, ctx.chat.id, filePath);
  });

  // ── Boot ───────────────────────────────────────────────────────────────────

  sessions.loadFromDisk();

  // Уведомление о запуске — в группу (коротко)
  await bot.telegram.sendMessage(ADMIN_GROUP_ID,
    `🟢 Alesa запущена · ${auth.currentMode() === MODE.APIKEY ? 'API Key' : 'OAuth'}`
  ).catch(() =>
    bot.telegram.sendMessage(ADMIN_USER_ID,
      `🟢 Alesa запущена · ${auth.currentMode() === MODE.APIKEY ? 'API Key' : 'OAuth'}`
    )
  );
  createLogServer();
  console.log(`Alesa started. Auth: ${auth.currentMode()}`);

  async function gracefulShutdown(signal) {
    console.log(`Shutdown: ${signal}`);
    bot.stop(signal);

    // Notify users whose tasks were interrupted
    for (const [, run] of activeTasks) {
      try {
        await bot.telegram.sendMessage(run.chatId,
          '⚠️ Бот перезапускается — текущая задача прервана. Повтори запрос через несколько секунд.');
      } catch {}
    }

    sessions.persist();
    process.exit(0);
  }

  process.once('SIGINT', () => gracefulShutdown('SIGINT'));
  process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));

  bot.launch();
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
