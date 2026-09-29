// ⛔ Стоп for a chat (#1856) — one path for /stop, /стоп and the ⛔ button.
//
// The agent's /tasks/stop only kills a RUNNING process. In prod (29.09) most stops
// landed between runs: the agent killed 0, and the gateway's own intake queue then
// launched the next buffered batch (run-finished → launchAfterRelease, the judge's
// debounce alarm, a remembered ▶️). So a stop first reaches the chat's IntakeBuffer
// DO — clears every launch intent/timer and holds the messages (collector «⛔
// Остановлено. N ждут — ▶️») — and only then asks the agent to kill the run. That
// order matters: the run-finished push the kill triggers must find no intent left.
import { conversationKey } from '../conversation-context.js';
import { stopTask } from './agent-client.js';

export async function stopChat(env, { username, chatId, threadId = null, replyTo = null }) {
  let intake = null;
  if (env.INTAKE) {
    try {
      const stub = env.INTAKE.get(env.INTAKE.idFromName(conversationKey(chatId, threadId)));
      const res = await stub.fetch('https://intake/stop', { method: 'POST',
        body: JSON.stringify({ replyTo, chatId, threadId }) });
      intake = res.ok ? await res.json() : null;
    } catch (e) {
      // Never let a buffer hiccup block the kill itself.
      console.error('[stop] intake hold failed:', e.message);
    }
  }
  let killed = 0;
  let error = null;
  try {
    const result = await stopTask(env, { username, chatId, threadId });
    killed = result?.killed || 0;
  } catch (e) {
    error = e;
  }
  const held = intake?.held || 0;
  console.log(`[stop] chat=${chatId} thread=${threadId ?? '-'} killed=${killed} held=${held} intent=${!!intake?.hadIntent}${error ? ` error=${error.message}` : ''}`);
  return { killed, held, hadIntent: !!intake?.hadIntent, intake: !!intake, error };
}

// One wording for both entry points. `null` = the DO's own «⛔ Остановлено. N
// ждут» collector already says everything — no second bubble.
export function stopReplyText({ killed, held, hadIntent, error }, { button = false } = {}) {
  if (killed > 0) return button ? '⛔ Задача остановлена.' : '🛑 Задача остановлена.';
  if (error && !held && !hadIntent) return `❌ Ошибка: ${error.message}`;
  if (held) return button ? '⛔ Остановлено — очередь не запустится сама.' : null;
  if (hadIntent) return '⛔ Автозапуск отменён.';
  return button ? '🤷 Нет активной задачи для остановки.' : '🤷 Нет активных задач для остановки.';
}
