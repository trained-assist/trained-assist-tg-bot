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
import { cancelRetries } from './kv.js';

// SS-05: a stop must also cancel work the gateway already put into delivery —
// the durable RunOutbox and the recovery queue — not only the running process.
// Otherwise the queued job self-launches minutes later and the user sees the
// stopped task "resurrect" (INV-08: stop suppresses every automatic resumption).
async function cancelOutbox(env, { username, chatId, threadId }) {
  if (!env.RUN_OUTBOX) return 0;
  try {
    const stub = env.RUN_OUTBOX.get(env.RUN_OUTBOX.idFromName(`${username}:${chatId}`));
    const res = await stub.fetch('https://outbox/cancel', {
      method: 'POST', body: JSON.stringify({ chatId, threadId }),
    });
    return res.ok ? (await res.json()).cancelled || 0 : 0;
  } catch (e) {
    console.error('[stop] outbox cancel failed:', e.message);
    return 0;
  }
}

async function cancelRecovery(env, { chatId, threadId }) {
  let cancelled = 0;
  try {
    // Recovery lives in exactly one place: RECOVERY_STORE, else the RetryQueue
    // DO (plus the legacy shared-KV queue it imports while the flag is on), else
    // the shared SESSIONS KV.
    if (env.RECOVERY_STORE) {
      cancelled += await cancelRetries(env.RECOVERY_STORE, chatId, threadId);
    } else if (env.RETRY_QUEUE) {
      const stub = env.RETRY_QUEUE.get(env.RETRY_QUEUE.idFromName('recovery'));
      const res = await stub.fetch('https://recovery/cancel', {
        method: 'POST', body: JSON.stringify({ chatId, threadId }),
      });
      if (res.ok) cancelled += (await res.json()).cancelled || 0;
      if (env.RECOVERY_IMPORT_LEGACY === 'on') cancelled += await cancelRetries(env.SESSIONS, chatId, threadId);
    } else {
      cancelled += await cancelRetries(env.SESSIONS, chatId, threadId);
    }
  } catch (e) {
    console.error('[stop] recovery cancel failed:', e.message);
  }
  return cancelled;
}

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
  // Cancel queued delivery BEFORE killing the run: the kill triggers run-finished,
  // which must not find a still-queued job to launch.
  const cancelled = await cancelOutbox(env, { username, chatId, threadId })
    + await cancelRecovery(env, { chatId, threadId });
  let killed = 0;
  let error = null;
  try {
    const result = await stopTask(env, { username, chatId, threadId });
    killed = result?.killed || 0;
  } catch (e) {
    error = e;
  }
  const held = intake?.held || 0;
  console.log(`[stop] chat=${chatId} thread=${threadId ?? '-'} killed=${killed} held=${held} cancelled=${cancelled} intent=${!!intake?.hadIntent}${error ? ` error=${error.message}` : ''}`);
  return { killed, held, cancelled, hadIntent: !!intake?.hadIntent, intake: !!intake, error };
}

// One wording for both entry points. `null` = the DO's own «⛔ Остановлено. N
// ждут» collector already says everything — no second bubble.
export function stopReplyText({ killed, held, cancelled = 0, hadIntent, error }, { button = false } = {}) {
  if (killed > 0) return button ? '⛔ Задача остановлена.' : '🛑 Задача остановлена.';
  if (error && !held && !hadIntent && !cancelled) return `❌ Ошибка: ${error.message}`;
  // A cancelled queued delivery must be stated plainly — never «отправлю
  // автоматически»: the whole point of the stop is that nothing runs later.
  if (cancelled) return button ? '⛔ Остановлено — очередь не запустится сама.' : '⛔ Остановлено — задача снята с очереди и сама не запустится.';
  if (held) return button ? '⛔ Остановлено — очередь не запустится сама.' : null;
  if (hadIntent) return '⛔ Автозапуск отменён.';
  return button ? '🤷 Нет активной задачи для остановки.' : '🤷 Нет активных задач для остановки.';
}
