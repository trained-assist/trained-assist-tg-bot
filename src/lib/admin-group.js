import commandsRegistry from '../../commands-registry.json';
// Admin-group identity. A Telegram basic group gets a new id when it is
// upgraded to a supergroup (toggling history visibility, adding admins with
// some rights, >200 members…): -4312117839 → -1004312117839. The configured
// ADMIN_GROUP_ID secret keeps the old id, so every /adduser etc. silently fell
// through to the ordinary group path → "❓ Неизвестная команда" (2026-09-24).
// Treat both forms of the same group as equal, and allow a comma-separated
// list so a deliberate move to another chat doesn't need a code change.

function canonical(id) {
  const s = String(id ?? '').trim();
  const m = /^-100(\d+)$/.exec(s) || /^-(\d+)$/.exec(s);
  return m ? `g${m[1]}` : s;
}

export function isAdminGroupChat(chatId, adminGroupId) {
  if (chatId == null || !adminGroupId) return false;
  const target = canonical(chatId);
  if (!target) return false;
  return String(adminGroupId).split(',').some(id => {
    const c = canonical(id);
    return c !== '' && c === target;
  });
}

const ADMIN_ONLY_RE = /^\/(adduser|deluser|listusers|resetpass|pass_reset)(?:@\w+)?(?:\s|$)/i;

// Registry-driven local admin-only commands (commands-registry.json:
// handler:"local" + adminOnly, e.g. /test_mode). Same treatment as the
// hand-listed ADMIN_ONLY_RE: usable in the admin chat, adminOnlyHint elsewhere.
// Deliberately NOT including forward+adminOnly entries (/get_webpass) — those
// keep their existing passthrough behaviour outside the admin chat.
const ADMIN_ONLY_LOCAL = new Set(
  commandsRegistry.commands
    .filter(c => c.handler === 'local' && c.adminOnly)
    .flatMap(c => [c.command, ...c.aliases])
);

function commandToken(text) {
  return String(text || '').trim().split(/\s+/)[0].split('@')[0].toLowerCase();
}

// Exact-token match (unlike isUserMgmtCommand's prefix match) — used only to
// explain a refusal outside the admin chat instead of "Неизвестная команда".
export function isAdminOnlyCommand(text) {
  return ADMIN_ONLY_RE.test(String(text || '').trim()) || ADMIN_ONLY_LOCAL.has(commandToken(text));
}

// Local admin-only commands — the admin-group branch in index.js must route
// these to handleCommand (it otherwise only forwards user-mgmt commands and
// drops everything else in silence).
export function isAdminLocalCommand(text) {
  return ADMIN_ONLY_LOCAL.has(commandToken(text));
}

export function adminOnlyHint(chatId) {
  return `⛔ Эта команда работает только в админ-чате. ID этого чата: ${chatId} — `
    + `если это и есть админ-чат, обнови секрет ADMIN_GROUP_ID.`;
}
