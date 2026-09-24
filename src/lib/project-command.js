// /project, /projects, /проект, /проекты — mirrors the agent's PROJECT_INTENT
// (trained-assist-agent src/runner/intent-engine.js).
export const PROJECT_COMMAND_RE = /^\/(?:projects?|проекты?|проект)(?:@\S+)?(?=\s|$)/i;

// `/project <номер|название>` and `/project new <…>` change (and pin) the chat's
// project in the agent (#1318). Bare `/project` only lists; `rename` doesn't move the chat.
export function isProjectSwitch(text) {
  const t = String(text || '').trim();
  if (!PROJECT_COMMAND_RE.test(t)) return false;
  const rest = t.replace(PROJECT_COMMAND_RE, '').trim();
  return !!rest && !/^(?:rename|переименуй|переименовать|назови)\s/i.test(rest);
}
