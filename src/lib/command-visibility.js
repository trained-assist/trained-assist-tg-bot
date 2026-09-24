// Single source of truth for "does this bot's audience see this command?".
//
// Used by BOTH the /start listing (handlers/commands.js#cmdStart) and the
// Telegram command menu (lib/telegram.js#registerBotCommands) so the two can
// never drift — the old hardcoded recruiterHidden/recruiterOnly branches were
// duplicated in each place and only stayed in sync by hand.
//
// Visibility lives in commands-registry.json as an `audiences` allow-list
// (default / recruiter / freelance). Hidden and adminOnly entries are never
// advertised regardless of audience (they stay callable when typed directly).
export function isCommandVisible(entry, audience) {
  if (entry.hidden || entry.adminOnly) return false;
  if (!Array.isArray(entry.audiences)) return true; // no allow-list → visible everywhere
  return entry.audiences.includes(audience);
}
