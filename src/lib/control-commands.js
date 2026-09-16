export const CONTROL_COMMANDS = [
  { command: 'stop', description: 'Остановить сессию и сохранить весь ввод' },
  { command: 'skip', description: 'Перейти к следующему вводу — появилась новая информация' },
  { command: 'fresh', description: 'Начать без незавершённого ввода' },
];

// Bot menu is global Telegram state, so staging must never register it.
export async function ensureControlCommands(env) {
  if (env.CONTROL_COMMANDS_ENABLED !== 'on' || !env.BOT_TOKEN) return;
  const key = `control-commands:v1:${env.BOT_TOKEN.split(':')[0]}`;
  if (await env.SESSIONS.get(key)) return;
  const api = async (method, body) => {
    const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const value = await res.json();
    if (!res.ok || !value.ok) throw new Error(`Telegram ${method} failed`);
    return value.result;
  };
  for (const type of ['default', 'all_private_chats', 'all_group_chats']) {
    for (const language_code of ['', 'ru']) {
      const scope = { type };
      const previous = await api('getMyCommands', { scope, language_code });
      const commands = [...CONTROL_COMMANDS, ...(Array.isArray(previous) ? previous : [])
        .filter(c => !CONTROL_COMMANDS.some(x => x.command === c.command))].slice(0, 100);
      await api('setMyCommands', { scope, language_code, commands });
    }
  }
  await env.SESSIONS.put(key, 'registered');
}
