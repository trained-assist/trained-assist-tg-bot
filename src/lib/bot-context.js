// Data namespace and reply identity are separate deployment settings.
function identifier(value, label) {
  const id = value || 'default';
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(id)) throw new Error('Invalid ' + label);
  return id;
}
export const resolveAudience = env => identifier(env.SESSION_NAMESPACE, 'audience');
export const resolveBotId = env => identifier(env.BOT_ID, 'botId');
