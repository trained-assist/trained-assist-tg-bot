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

const ADMIN_ONLY_RE = /^\/(adduser|deluser|listusers|resetpass)(?:@\w+)?(?:\s|$)/i;

// Exact-token match (unlike isUserMgmtCommand's prefix match) — used only to
// explain a refusal outside the admin chat instead of "Неизвестная команда".
export function isAdminOnlyCommand(text) {
  return ADMIN_ONLY_RE.test(String(text || '').trim());
}

export function adminOnlyHint(chatId) {
  return `⛔ Эта команда работает только в админ-чате. ID этого чата: ${chatId} — `
    + `если это и есть админ-чат, обнови секрет ADMIN_GROUP_ID.`;
}
