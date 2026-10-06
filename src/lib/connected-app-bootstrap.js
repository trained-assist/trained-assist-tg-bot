// Verified-webhook-only bridge to Control Plane's first-party browser bootstrap.
// No browser link or profile ID is created here; CP checks a reviewed actor binding.
import { sendMessage } from './telegram.js';

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const command = /^\/connect(?:@([A-Za-z0-9_]{1,64}))?$/i;

export function isConnectCommand(message, botUsername) {
  const text = typeof message?.text === 'string' ? message.text.trim() : '';
  const match = command.exec(text);
  return !!match && (!match[1] || match[1].toLowerCase() === String(botUsername || '').toLowerCase());
}

export async function dispatchConnect(update, env, botId) {
  const message = update?.message;
  const chatId = message?.chat?.id;
  const actorId = message?.from?.id;
  const now = Math.floor(Date.now() / 1000);
  const valid = message?.chat?.type === 'private' && Number.isSafeInteger(chatId) && chatId > 0 &&
    Number.isSafeInteger(actorId) && actorId === chatId && Number.isSafeInteger(update?.update_id) &&
    update.update_id > 0 && Number.isSafeInteger(message?.date) &&
    message.date <= now + 60 && message.date >= now - 300 &&
    typeof botId === 'string' && ID.test(botId);
  if (!valid) {
    if (message?.chat?.type === 'private' && Number.isSafeInteger(chatId) && chatId > 0)
      await sendMessage(env.BOT_TOKEN, chatId, 'Откройте новую ссылку командой /connect.');
    return { accepted: false, reason: 'invalid_private_update' };
  }
  let endpoint;
  try {
    endpoint = new URL(env.CONNECTED_APP_CONTROL_PLANE_URL);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
        endpoint.pathname !== '/') throw new Error('invalid endpoint');
  } catch { return { accepted: false, reason: 'control_plane_unavailable' }; }
  const key = env.CONNECTED_APP_TELEGRAM_GATEWAY_KEY;
  if (typeof key !== 'string' || key.length < 32) return { accepted: false, reason: 'gateway_key_unavailable' };
  try {
    const response = await fetch(new URL('/v1/connected-app-bootstrap/telegram/start', endpoint), {
      method: 'POST', redirect: 'manual',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ botId, updateId: String(update.update_id), telegramUserId: String(actorId),
        chatId, chatType: 'private' }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => null);
    if (response.status === 202 && body?.accepted === true) {
      return { accepted: true, duplicate: body.duplicate === true };
    }
  } catch { /* no retry: CP may have accepted this update and sent a link */ }
  await sendMessage(env.BOT_TOKEN, chatId, 'Ссылка пока недоступна. Попробуйте /connect ещё раз.');
  return { accepted: false, reason: 'control_plane_unavailable' };
}
