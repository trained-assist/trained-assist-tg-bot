import { sendMessage } from '../lib/telegram.js';
import { getUser, setUser, deleteUser, listUsernames } from '../lib/kv.js';

const ADMIN_COMMANDS = ['/reauth', '/um', '/adduser', '/deluser', '/listusers', '/resetpass', '/stats'];

export function isUserMgmtCommand(text) {
  return ADMIN_COMMANDS.some(cmd => text.startsWith(cmd));
}

export async function handleUserMgmt(msg, env) {
  const { chat, text } = msg;
  const chatId = chat.id;
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].split('@')[0];

  switch (cmd) {
    case '/um':        return cmdGuide(chatId, env);
    case '/adduser':   return cmdAddUser(chatId, parts, env);
    case '/deluser':   return cmdDelUser(chatId, parts, env);
    case '/listusers': return cmdListUsers(chatId, env);
    case '/resetpass': return cmdResetPass(chatId, parts, env);
    case '/stats':     return cmdStats(chatId, env);
    // /reauth is handled by agent directly — TODO
  }
}

async function cmdGuide(chatId, env) {
  await sendMessage(env.BOT_TOKEN, chatId,
    `👤 <b>Управление пользователями</b>\n\n` +

    `<b>Создать пользователя</b>\n` +
    `<code>/adduser username [Имя Фамилия]</code>\n` +
    `→ Бот создаёт профиль и генерирует пароль.\n\n` +

    `<b>Сбросить пароль</b>\n` +
    `<code>/resetpass username</code>\n\n` +

    `<b>Удалить пользователя</b>\n` +
    `<code>/deluser username</code>\n\n` +

    `<b>Список пользователей</b>\n` +
    `<code>/listusers</code>\n\n` +

    `<b>Что делает пользователь</b>\n` +
    `1. Пишет боту: <code>/login username password</code>\n` +
    `2. Дальше общается как обычно.\n` +
    `3. Выход: <code>/logout</code>`
  );
}

function generatePassword(len = 10) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  // Use crypto.getRandomValues in Workers
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  for (const b of arr) out += chars[b % chars.length];
  return out;
}

async function hashPassword(password) {
  // Workers don't have crypto.scrypt — use PBKDF2 via SubtleCrypto
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 },
    key, 256
  );
  const saltHex = [...salt].map(b => b.toString(16).padStart(2, '0')).join('');
  const hashHex = [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
  return { hash: hashHex, salt: saltHex };
}

async function cmdAddUser(chatId, parts, env) {
  const username = parts[1];
  if (!username) return sendMessage(env.BOT_TOKEN, chatId, 'Использование: /adduser username [Имя Фамилия]');
  const displayName = parts.slice(2).join(' ') || username;

  const existing = await getUser(env.USERS, username);
  if (existing) return sendMessage(env.BOT_TOKEN, chatId, `❌ Пользователь "${username}" уже существует.`);

  const password = generatePassword();
  const { hash, salt } = await hashPassword(password);
  await setUser(env.USERS, username, {
    name: displayName,
    passwordHash: hash,
    salt,
    createdAt: new Date().toISOString(),
  });

  await sendMessage(env.BOT_TOKEN, chatId,
    `✅ Пользователь создан:\n\n` +
    `Логин: <code>${username}</code>\n` +
    `Пароль: <code>${password}</code>\n\n` +
    `Передай пользователю — он вводит:\n<code>/login ${username} ${password}</code>`
  );
}

async function cmdDelUser(chatId, parts, env) {
  const username = parts[1];
  if (!username) return sendMessage(env.BOT_TOKEN, chatId, 'Использование: /deluser username');
  const existing = await getUser(env.USERS, username);
  if (!existing) return sendMessage(env.BOT_TOKEN, chatId, `❌ Пользователь "${username}" не найден.`);
  await deleteUser(env.USERS, username);
  // TODO: also delete their sessions from SESSIONS KV
  await sendMessage(env.BOT_TOKEN, chatId, `✅ Пользователь @${username} удалён.`);
}

async function cmdListUsers(chatId, env) {
  const usernames = await listUsernames(env.USERS);
  if (!usernames.length) return sendMessage(env.BOT_TOKEN, chatId, 'Нет зарегистрированных пользователей.');
  const lines = await Promise.all(usernames.map(async u => {
    const data = await getUser(env.USERS, u);
    return `• <b>${data?.name || u}</b> (@${u})`;
  }));
  await sendMessage(env.BOT_TOKEN, chatId,
    `👥 <b>Пользователи (${usernames.length})</b>\n\n${lines.join('\n')}`
  );
}

async function cmdStats(chatId, env) {
  let text;
  try {
    const res = await fetch(`${env.AGENT_URL}/stats`, {
      headers: { 'Authorization': `Bearer ${env.AGENT_SECRET}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const s = await res.json();
    const memPct = Math.round(s.memory.usedMb / s.memory.totalMb * 100);
    const diskPct = s.disk ? Math.round(s.disk.usedMb / s.disk.totalMb * 100) : null;
    const uptimH = Math.floor(s.uptime / 3600);
    const uptimM = Math.floor((s.uptime % 3600) / 60);
    text =
      `🖥 <b>Ресурсы VM</b>\n\n` +
      `<b>CPU:</b> ${s.cpu.cores} ядра · нагрузка ${s.cpu.load1m.toFixed(2)} / ${s.cpu.load5m.toFixed(2)}\n` +
      `<b>RAM:</b> ${s.memory.usedMb} / ${s.memory.totalMb} МБ (${memPct}%)\n` +
      (diskPct !== null ? `<b>Диск:</b> ${s.disk.usedMb} / ${s.disk.totalMb} МБ (${diskPct}%)\n` : '') +
      `<b>Uptime агента:</b> ${uptimH}ч ${uptimM}м`;
  } catch (e) {
    text = `❌ Не удалось получить статистику: ${e.message}`;
  }
  await sendMessage(env.BOT_TOKEN, chatId, text);
}

async function cmdResetPass(chatId, parts, env) {
  const username = parts[1];
  if (!username) return sendMessage(env.BOT_TOKEN, chatId, 'Использование: /resetpass username');
  const existing = await getUser(env.USERS, username);
  if (!existing) return sendMessage(env.BOT_TOKEN, chatId, `❌ Пользователь "${username}" не найден.`);

  const password = generatePassword();
  const { hash, salt } = await hashPassword(password);
  await setUser(env.USERS, username, { ...existing, passwordHash: hash, salt });

  await sendMessage(env.BOT_TOKEN, chatId,
    `🔑 Новый пароль для <code>${username}</code>:\n<code>${password}</code>\n\n` +
    `Для входа: <code>/login ${username} ${password}</code>`
  );
}
