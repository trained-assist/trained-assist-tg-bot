/**
 * Dynamic user registry with login/password auth.
 * Persisted to DATA_DIR/.registry.json — survives VM reboots (disk is permanent).
 *
 * Two auth paths:
 *  - Legacy: chat_id is in LEGACY_USERS → user is always authenticated (no password needed)
 *  - New:    user sends /login username password → chat_id bound to profile
 */

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR     = process.env.ALESA_DATA_DIR || path.join(process.env.HOME || '/home/vova', 'alesa-sessions');
const REGISTRY_FILE = path.join(DATA_DIR, '.registry.json');

// Users that existed before the login/password system — always authenticated by chat_id.
const LEGACY_USERS = [
  { id: 1714048,   name: 'Vladimir', username: 'kobzevvv',        workDir: '/home/vova/alesa-sessions/vladimir' },
  { id: 760768429, name: 'Mariam',   username: 'proshaimamochka', workDir: '/home/vova/alesa-sessions/mariam'   },
];
const LEGACY_BY_CHAT_ID = new Map(LEGACY_USERS.map(u => [u.id, u]));

// ── Persistence ──────────────────────────────────────────────────────────────

function emptyRegistry() {
  return { users: {}, sessions: {} };
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
  } catch {
    return emptyRegistry();
  }
}

function save(reg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(reg, null, 2));
}

// ── Password helpers ─────────────────────────────────────────────────────────

function generatePassword(len = 10) {
  return crypto.randomBytes(len).toString('base64url').slice(0, len);
}

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, s, 32).toString('hex');
  return { hash, salt: s };
}

function verifyPassword(password, storedHash, storedSalt) {
  const { hash } = hashPassword(password, storedSalt);
  return hash === storedHash;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Look up user by Telegram chat_id.
 * Returns user object { id, name, username, workDir } or null.
 */
function getUserByChatId(chatId) {
  // Legacy users always authenticated
  if (LEGACY_BY_CHAT_ID.has(chatId)) return LEGACY_BY_CHAT_ID.get(chatId);

  // Session-bound users
  const reg = load();
  const username = reg.sessions[String(chatId)];
  if (!username || !reg.users[username]) return null;

  const u = reg.users[username];
  return { id: chatId, name: u.name, username, workDir: u.workDir };
}

/**
 * Verify login/password. Returns user object on success, null on failure.
 */
function loginUser(chatId, username, password) {
  const reg = load();
  const u = reg.users[username];
  if (!u) return null;
  if (!verifyPassword(password, u.passwordHash, u.salt)) return null;

  // Bind this chat_id to the profile
  reg.sessions[String(chatId)] = username;
  save(reg);

  return { id: chatId, name: u.name, username, workDir: u.workDir };
}

/**
 * Unbind chat_id (logout).
 */
function logoutUser(chatId) {
  const reg = load();
  delete reg.sessions[String(chatId)];
  save(reg);
}

/**
 * Create a new user profile. Returns { username, password } on success.
 * Throws if username already exists.
 */
function addUser(username, displayName) {
  const reg = load();
  if (reg.users[username]) throw new Error(`User "${username}" already exists`);

  const password = generatePassword();
  const { hash, salt } = hashPassword(password);
  const workDir = path.join(DATA_DIR, username);

  reg.users[username] = {
    name: displayName || username,
    workDir,
    passwordHash: hash,
    salt,
    createdAt: new Date().toISOString(),
  };
  save(reg);
  fs.mkdirSync(workDir, { recursive: true });

  return { username, password };
}

/**
 * Remove a user profile and their active sessions.
 * Returns true if removed, false if not found.
 */
function removeUser(username) {
  const reg = load();
  if (!reg.users[username]) return false;

  delete reg.users[username];
  // Remove any bound sessions
  for (const [chatId, uname] of Object.entries(reg.sessions)) {
    if (uname === username) delete reg.sessions[chatId];
  }
  save(reg);
  return true;
}

/**
 * Reset password for a user. Returns new password or null if user not found.
 */
function resetPassword(username) {
  const reg = load();
  const u = reg.users[username];
  if (!u) return null;

  const password = generatePassword();
  const { hash, salt } = hashPassword(password);
  u.passwordHash = hash;
  u.salt = salt;
  save(reg);
  return password;
}

/**
 * List all managed users (not legacy hardcoded ones).
 * Returns array of { username, name, workDir, createdAt, activeSessions }
 */
function listUsers() {
  const reg = load();
  const sessionsByUser = {};
  for (const [chatId, uname] of Object.entries(reg.sessions)) {
    sessionsByUser[uname] = (sessionsByUser[uname] || 0) + 1;
  }

  const managed = Object.entries(reg.users).map(([username, u]) => ({
    username,
    name: u.name,
    workDir: u.workDir,
    createdAt: u.createdAt,
    activeSessions: sessionsByUser[username] || 0,
  }));

  const legacy = LEGACY_USERS.map(u => ({
    username: u.username,
    name: u.name,
    workDir: u.workDir,
    createdAt: '(legacy)',
    activeSessions: '—',
  }));

  return [...legacy, ...managed];
}

module.exports = {
  getUserByChatId,
  loginUser,
  logoutUser,
  addUser,
  removeUser,
  resetPassword,
  listUsers,
  LEGACY_USERS,
};
