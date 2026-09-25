// /project, /projects, /проект, /проекты — mirrors the agent's PROJECT_INTENT
// (trained-assist-agent src/runner/intent-engine.js).
export const PROJECT_COMMAND_RE = /^\/(?:projects?|проекты?|проект)(?:@\S+)?(?=\s|$)/i;

// `/project <номер|название>` and `/project new <…>` change (and pin) the chat's
// project in the agent (#1318). Bare `/project` only lists; `rename` doesn't move the chat.
export function isProjectSwitch(text) {
  const t = String(text || '').trim();
  if (!PROJECT_COMMAND_RE.test(t)) return false;
  const rest = t.replace(PROJECT_COMMAND_RE, '').trim();
  if (!rest || /^(?:current|status|now|текущий|сейчас|какой)\s*\??$/i.test(rest)) return false; // read-only
  return !/^(?:rename|переименуй|переименовать|назови)\s/i.test(rest);
}

// Plain-language chat-config phrases → the equivalent agent command, so they behave exactly
// like the slash command: answered at once (not buffered in intake, no project picker —
// the picker for «закрепи X» was the bug), and a pin change resets the gateway's cached
// project (resetChatProject). Only short single-line messages; anything else is a task.
const PIN_CURRENT_RE = /^(?:какой\s+)?(?:текущий|активный|закрепл[её]нный)\s+проект\s*\??$|^какой\s+(?:у\s+(?:этого\s+)?чата\s+)?проект(?:\s+(?:закрепл[её]н|выбран|у\s+(?:этого\s+)?чата))?\s*\??$|^проект\s+чата\s*\??$/i;
const PIN_MENU_RE = /^(?:смени(?:ть)?|поменя(?:й|ть)|переключи(?:ть)?|выбери|выбрать)\s+проект\s*$/i;
const PIN_CLEAR_RE = /^(?:сними|снять|убери|убрать|отмени|отменить)\s+(?:закрепление|закреп|пин)(?:\s+(?:проекта|с\s+проекта))?\s*$|^открепи(?:ть)?(?:\s+проект)?\s*$|^(?:верни|вернуть)\s+авто(?:матический|матическое)?(?:\s+(?:выбор|определение))?(?:\s+проекта)?\s*$/i;
const PIN_SET_RE = /^(?:закрепи(?:ть)?(?:\s+за\s+(?:этим\s+)?чатом)?(?:\s+проект)?|(?:смени|поменяй|переключи)\s+проект\s+на|переключись\s+на\s+проект)\s+(.+)$/i;
const NOT_A_PROJECT_RE = /сообщени|пост|задач|файл|ссылк|^(?:это|его|её|ее|их|вверху|наверху)$/i;
const SETTINGS_RE = /^(?:покажи\s+)?(?:мои\s+)?(?:настройки|конфиг(?:урацию)?)(?:\s+(?:чата|агента|ассистента))?\s*\??$|^(?:get\s+config|user\s+settings|show\s+settings|settings|config)$/i;

export function chatConfigCommandFromPhrase(text) {
  const t = String(text || '').trim();
  if (!t || t.startsWith('/') || t.includes('\n') || t.length > 80) return null;
  if (SETTINGS_RE.test(t)) return '/settings';
  if (PIN_CURRENT_RE.test(t)) return '/project current';
  if (PIN_CLEAR_RE.test(t)) return '/project unpin';
  if (PIN_MENU_RE.test(t)) return '/project';
  const m = t.match(PIN_SET_RE);
  if (m) {
    const name = m[1].trim().replace(/^[«"']|[»"'.!]+$/g, '').trim();
    if (name && name.length <= 60 && !NOT_A_PROJECT_RE.test(name)) return `/project pin ${name}`;
  }
  return null;
}
