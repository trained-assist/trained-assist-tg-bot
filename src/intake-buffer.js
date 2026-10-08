import { initTestMode } from './lib/test-mode.js';
import { assembleInput } from './input-assembly.js';
import { mediaEnabled, mediaOf, mediaId, enqueueMedia } from './media-jobs.js';
import { getSession } from './lib/kv.js';
import { checkCompleteness } from './lib/agent-client.js';
import { applySessionNamespace } from './lib/session-namespace.js';
import { closePendingBatch, registerPendingBatch } from './lib/pending-intake.js';
import { controlPlaneClient, publishRoutingDegradation } from './lib/control-plane-execution.js';
import { isTerminalTaskStatus } from './sandbox-tg/contract.js';
import { TgDeliveryOwnerClient } from './sandbox-tg/delivery-owner.js';
// Durable Object: per-chat intake buffer.
//
// Automatic launch needs a quiet period AND an actionable request. The judge sets
// the period (30 s for a short continuation whose target the previous agent answer
// makes obvious, 3 min otherwise) and says it out loud; explicit launch commands
// and buttons bypass the timer. New input invalidates any in-flight gate verdict;
// reservation compares the exact checked buffer under lock.
// Files alone are context, never an instruction. Gate failures keep the collector.
//
// Two states, both owned here so the rule is one place for every user:
//   • idle     — messages pile into `buf`; a single collector message shows the
//                launch button and its live count. A debounce alarm is armed.
//   • busy     — a run is in flight for this chat: new messages accumulate
//                silently and are surfaced with a fresh launch button once the run
//                finishes (never auto-dispatched).
//
// One instance per chat_id (idFromName(chatId)). DO fetch/alarm handlers can
// interleave at external awaits. Short state mutations use an explicit lock;
// Telegram and transcription I/O must never hold that lock.
// The alarm also recovers reserved media jobs; for runs it is a safety net: if a run's isolate dies before clearing `busy`,
// BUSY_MAX_MS releases the hold so the buffer can't be trapped forever.

import { sendMessage, sendDocument, sendMessageWithKeyboard, editMessage } from './lib/telegram.js';
import { coalesceBuffer, coalesceItem, FORCE_RUN_RE } from './intake-routing.js';
import { controlPlaneStopDisabled, controlPlaneStopDisabledError } from './lib/control-plane-stop-gate.js';
import { conversationKey, threadExtra, threadIdOf } from './conversation-context.js';
import { pruneHistory } from './group-history.js';

// Local tracked-send wrappers (NOT extra exports in lib/telegram.js — that would
// force every test that mocks that module to declare them). They call the imported
// sendMessage/sendMessageWithKeyboard (so existing mocks/assertions still work) and
// remember the id for /clean_up_flood. Only text; documents are artifacts.
async function recordSent(env, chatId, result) {
  const id = result?.result?.message_id;
  if (id == null || !env?.SESSIONS) return;
  try {
    const key = `sent:${chatId}`;
    const val = await env.SESSIONS.get(key);
    const ids = val ? JSON.parse(val) : [];
    if (!ids.includes(id)) ids.push(id);
    await env.SESSIONS.put(key, JSON.stringify(ids.slice(-300)), { expirationTtl: 3 * 24 * 60 * 60 });
  } catch (e) {
    console.error('[sent] record failed:', e.message);
  }
}
async function sendTracked(env, chatId, text, extra, threadId) {
  const result = await sendMessage(env.BOT_TOKEN, chatId, text, { ...extra, ...threadExtra(threadId) });
  await recordSent(env, chatId, result);
  return result;
}
async function sendKeyboardTracked(env, chatId, text, keyboard, extra, threadId) {
  const result = await sendMessageWithKeyboard(env.BOT_TOKEN, chatId, text, keyboard, { ...extra, ...threadExtra(threadId) });
  await recordSent(env, chatId, result);
  return result;
}

// Reply-anchor a new message to the one that triggered it — the only way a fresh
// bubble reliably appears right after the user's own message once the chat has
// scrolled (an edit to an older bubble is invisible off-screen). Best-effort:
// if the source message was since deleted, still deliver un-anchored.
const anchor = messageId => (messageId ? { reply_to_message_id: messageId, allow_sending_without_reply: true } : {});

const BUSY_MAX_MS = 45 * 60_000; // safety: release a run marked busy whose isolate
                                 // died mid-flight. Must exceed the longest
                                 // legitimate session (~40 min agent cap).
const BUSY_POLL_MS = 60_000;     // while busy, the alarm ticks this often and asks the
                                 // agent GET /tasks/running?chatId= whether the run
                                 // settled — the safety net for a lost run-finished
                                 // push. The hold is released on the first idle tick,
                                 // so a dropped push costs ~1 min, not BUSY_MAX_MS.
const DEBOUNCE_MS = 3 * 60_000; // quiet period for ALL automatic launches
// Граница ожидания пакета ДЛЯ НАРУЖНОГО НАБЛЮДЕНИЯ (arch#132 R9). Это не таймер
// запуска: пользователь законно может дописывать пачку минутами. Значение —
// заведомо больше сборки медиа и тишины пользователя, но меньше BUSY_MAX_MS, чтобы
// «у пользователя всё ещё открыт редактор» никогда не выглядело как потерянный ввод.
const PENDING_BATCH_DEADLINE_MS = 30 * 60_000;
// Ключ пакета ЛОКАЛЕН для инстанса DO: сам Durable Object и есть «чат», поэтому
// ключ не зависит от chatId — иначе /clear (у которого чата в теле нет) не мог бы
// закрыть пакет.
const BATCH_KEY = 'pendingBatch';
// How long the agent's /tasks/running answer stays untrusted for a window whose
// dispatch went through the outbox. Two owners release that hold before this (the
// outbox on permanent reject and on prolonged agent downtime); this only covers a
// lost outbox record. Well under BUSY_MAX_MS so a lost job degrades to «agent says
// nothing is running» instead of «chat frozen for 45 minutes» (prod 2026-10-04).
const OUTBOX_POLL_GRACE_MS = 10 * 60_000;
const MEDIA_DEADLINE_MS = 15 * 60_000; // don't wait on a media job forever: past this the
                                       // item is dropped from the batch as failed, so a lost
                                       // MediaJob alarm can't leave the chat permanently
                                       // un-launchable («ещё грузится» on every tap).

// Safety-net cadence for the buffer invariant below (see _ensureArmed). The
// debounce / park / media / busy alarms are the normal paths; this only
// re-checks when a branch consumed its alarm and left the batch un-timed.
const ARM_WATCHDOG_MS = 60_000;

const RECEIPT_MS = 1500;
const LAUNCH_BTN = [[{ text: '▶️ Запустить агента', callback_data: 'intake_run' },
  { text: '📋 Посмотреть input', callback_data: 'input_draft' }]];
const WORK_STYLES = ['explore', 'answer', 'auto'];
function workStyleKeyboard(revision, { busy = false, stopEnabled = true } = {}) {
  const labels = { explore: '🧭 Изучи и задай вопросы', answer: '📝 Дай полный ответ', auto: '✨ На твоё усмотрение' };
  const styles = WORK_STYLES.map(style => [{ text: labels[style], callback_data: `ws|${style}|${revision}` }]);
  if (busy) {
    styles.push([{ text: '⚡ Параллельно', callback_data: 'intake_parallel' }]);
    if (stopEnabled) styles.push([{ text: '🛑 Стоп и запуск с добавкой', callback_data: 'intake_stopsupp' },
      { text: '⛔ Стоп → новая задача', callback_data: 'intake_stopnew' }]);
    styles.push([{ text: '📋 Посмотреть input', callback_data: 'input_draft' }]);
  }
  styles.push([{ text: '🧹 Очистить весь ввод', callback_data: `intake_discard|${revision}` }]);
  return styles;
}
// Shown INSTEAD of LAUNCH_BTN under the statuses that mean "THIS batch is
// already taken": the tap happened, a ▶️ still sitting there is read as «нажата
// она или нет?» — the ambiguity the owner asked to remove (29.09). The mask follows
// the status, not chat state: a message that arrived DURING the run is a fresh
// batch nobody has launched, so its receipt keeps ▶️ (owner, 29.09 04:02:
// «вообще нет кнопки запустить … хотя я ни разу не нажимал») and the tap queues it
// for right after the run (/flush busy → launchAfterRelease).
const STATUS_BTN = [[{ text: '📋 Посмотреть input', callback_data: 'input_run' }]];
// Status overrides that themselves mean "the batch is taken" (📨 dispatching, 📥
// queued) — even before `busy` is set the launch button must go.
const TOOK_IT = /^(?:📨|📥)/;
// Shown in place of ▶️ once the user HAS tapped it (`launchQueued`): the launch is
// remembered (launchAfterRelease / launchWhenReady) and the only meaningful action
// left is to take it back. The owner's ask (29.09, 05:0x): «кнопка должна пропасть
// после нажатия … оставить хвост: отменить передачу агенту» — so the button never
// just vanishes, it turns into its own undo, and the state is unambiguous.
const CANCEL_BTN = [[{ text: '↩️ Отменить передачу агенту', callback_data: 'intake_cancel' }]];
// Busy context: the same intake_run tap is an EXPLICIT choice — queue this batch
// after the current run (Ф3 «меню явного выбора», RC-02, tg-bot#316). The generic
// «Запустить агента» wording belongs to idle, where the tap starts the run itself;
// under a running task it read as «и что случится, если нажать?».
// The busy menu carries ALL FOUR explicit choices of the scenario (§3):
// queue after the current run (RC-02), launch now as a parallel run in its own
// session (RC-03), stop the run and continue it with this input (RC-04), or stop
// it and start this input as an independent task (RC-05). The two stop options
// are the reason the menu exists: «➕ Дополнить» on the running task's message
// was removed (owner 30.09) — the same decision now lives where the user actually
// makes it: on the receipt of the input being held.
const STOP_SUPP_BTN = { text: '🛑 Стоп и запуск с добавкой', callback_data: 'intake_stopsupp' };
const STOP_NEW_BTN = { text: '⛔ Стоп → новая задача', callback_data: 'intake_stopnew' };
const QUEUE_BTN = [[{ text: '▶️ В очередь после текущей', callback_data: 'intake_run' },
  { text: '⚡ Параллельно', callback_data: 'intake_parallel' }],
  [STOP_SUPP_BTN, STOP_NEW_BTN],
  [{ text: '📋 Посмотреть input', callback_data: 'input_draft' }]];

// RC-04: the held input continues the task that just stopped — the SAME session,
// one run, with this note ahead of the user's own words (same marker the «➕
// Дополнить» restart used, so the model reads one history, not two).
const SUPPLEMENT_HEADER = '[Дополнение к задаче, которая только что выполнялась — она остановлена, продолжай с учётом этого:]';

const collectorText = n => `✓ Получил ${n} сообщений. Всё собрано в один input. Автозапуск — после 3 минут тишины, если задача понятна.`;
const heldText = n => `✓ Получил ещё ${n} сообщений, пока идёт задача. Решаешь ты: «В очередь» — уйдут сразу после неё; «Параллельно» — сразу, отдельной сессией; «Стоп и запуск с добавкой» / «Стоп → новая задача» — остановят текущую. Пока не выбрал — ждут и сами никуда не уйдут.`;
const queuedText = n => `⏳ Порция из ${n} сообщений уйдёт агенту сразу после текущей задачи. Передумал — отменить можно ниже.`;
// ⛔ Стоп (#1856): held input after a stop. Never auto-dispatched — only ▶️ or a
// NEW message sent after the stop re-arms launching.
const stoppedText = n => `⏸ ${n} сообщений отложены и сами не запустятся. Статус остановки текущей задачи проверяется отдельно.`;
// RC-04/RC-05 — a chosen «стоп + запуск» is in flight. The batch WILL start on its
// own here (that is what was chosen), so the text must not promise a button and
// must not re-ask the question; the only thing left is to take it back.
const stopLaunchText = (n, mode) => mode === 'supp'
  ? `⛔ Задача остановлена. ${n} сообщ. уйдут одним запуском — продолжу её с ними.`
  : `⛔ Задача остановлена. ${n} сообщ. уйдут одним запуском — новой задачей.`;
// A new message after ⛔ re-arms the normal flow; the pre-stop messages ride along
// only in plain sight — the collector names them (#1856).
const resumedNote = k => ` В том числе ${k} — отложенные до ⛔ Стоп («📋 Посмотреть input»).`;
const insufficientText = 'Не хватает контекста для автозапуска. Дополни input или нажми «▶️ Запустить агента».';

// Judge failure ≠ judge verdict (#248). Before this, a timeout/5xx from the gate
// consumed the debounce and the expiry branch went dark: buffer non-empty, no
// timer, no busy — the user's messages just sat there (live chat -1003814002203,
// 29.09). On `error` we keep the batch, retry the judge after a short pause, and
// only after the budget is spent hand over to the explicit «нажми ▶️» text.
const GATE_ERR_RETRY_MS = 60_000;      // first retry pause; grows is unnecessary — the judge is either up or not
const GATE_ERR_MAX_ATTEMPTS = 3;       // then stop retrying and offer the button plainly
const gateRetryText = (n) => `Судья запуска недоступен — повторю проверку через минуту (попытка ${n} из ${GATE_ERR_MAX_ATTEMPTS}). Агента можно запустить вручную: «▶️ Запустить агента».`;

// «Не хватает контекста» = park, never auto-launch. Product rule (owner 2026-09-22,
// #200): a half-written batch must not be guessed at — but it must not be SILENT
// either. Two live incidents (chat -1003814002203 29.09, -5423662529 02.10) had the
// same shape: the verdict only EDITED a collector bubble far up the chat and dropped
// the timer, so the user saw nothing and the batch sat for hours. Fix, both halves:
//   • the notice is a NEW message anchored under the user's own message (fresh: true)
//     — an edit of an old bubble is invisible once the chat has scrolled;
//   • the parked batch keeps ONE re-offer timer, then a durable `parked` marker in
//     /debug so it stays discoverable. Auto-launch stays OFF: guessing at an
//     unfinished task is worse than asking.
const PARK_REOFFER_MS = 15 * 60_000;   // one visible re-offer before the batch goes quiet for good
const parkReofferText = n => `Напоминаю: ${n} сообщ. ждут запуска — контекста для автозапуска так и не хватило. Дополни текст или нажми «▶️ Запустить агента».`;

// The user's typed instruction for a batch: prepared file contents must never
// masquerade as it (same rule as the expiry gate below — one definition).
function coalescedIntent(buf) {
  return buf.map(i => {
    const m = i.msg || {};
    if (m.document || m.photo || m.video) return i.intentText ?? m.caption ?? '';
    return coalesceItem(i);
  }).filter(Boolean).join('\n');
}

// What the running model sees of one held message (/held). `ready:false` = still
// downloading/preparing — show it, but the agent must not mark it consumed.
function heldView(item) {
  const m = item.msg || {};
  const { task: text, fileRefs, isVoice } = assembleInput([item], false);
  return {
    message_id: m.message_id ?? null,
    date: m.date ?? null,
    text,
    kind: isVoice ? 'voice' : fileRefs.length ? 'file' : 'text',
    files: fileRefs.filter(r => r.note !== false).map(r => r.name || r.id).filter(Boolean),
    ready: !(item.mediaPending || item.preparingAt),
  };
}

export class IntakeBuffer {
  constructor(state, env) {
    this.state = state;
    // Apply the same SESSION_NAMESPACE wrapping as dispatchInner — DO receives env
    // directly from the Workers runtime so it can't piggyback on the fetch-handler
    // wrapper. Without this, session reads inside the DO ignore the namespace and
    // can find sessions from a different bot (cross-bot auto-login bug).
    this.env = applySessionNamespace(env.EXECUTION_BACKEND === 'control-plane'
      ? { ...env, BOT_TOKEN: env.TG_SANDBOX_BOT_TOKEN, BOT_USERNAME: env.TG_SANDBOX_BOT_USERNAME }
      : env);
    // Test mode init point #2 — every send this accumulator makes goes through
    // lib/telegram.js, which reads the module cache (DESIGN §2.2).
    initTestMode(this.env);
    this.mutation = Promise.resolve();
    this.uiMutation = Promise.resolve();
    this.historyMutation = Promise.resolve();
    this.cpDispatches = 0;
  }

  // Group history (src/group-history.js) has its own lock: an ambient message must
  // never wait behind a long dispatch holding the intake mutex, and vice versa.
  async _historyExclusive(fn) {
    const previous = this.historyMutation;
    let release;
    this.historyMutation = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await fn(); } finally { release(); }
  }

  /**
   * Идентичность пакета накопителя для внешнего наблюдения (arch#132 R9).
   *
   * batchId стабилен, пока пакет жив, и МЕНЯЕТСЯ после запуска: следующая пачка —
   * другой вход с другим «первым сообщением». Время первого сообщения хранится
   * отдельно и не перебивается, иначе активный чат подменял бы возраст самого
   * старого непродвинувшегося ввода свежими.
   */
  async _batchIdLocked(chatId, threadId) {
    const store = this.state.storage;
    let batch = await store.get(BATCH_KEY);
    if (!batch?.batchId) {
      const ck = conversationKey(chatId, threadId);
      batch = { batchId: `${ck}#1`, seq: 1, conversationKey: ck, firstMessageAt: Date.now() };
      await store.put(BATCH_KEY, batch);
    }
    return batch;
  }

  async _readCollectorDelivery(stopWindow, buf) {
    const batch = await this.state.storage.get(BATCH_KEY);
    if (!batch?.batchId) return null;
    const baseKey = `cp-collector-send:${batch.batchId}`;
    if (stopWindow?.pending && (buf || []).length) {
      const revision = await this.state.storage.get('draftRevision');
      const revisionClaim = await this.state.storage.get(`${baseKey}:r${revision}`);
      if (revisionClaim) return revisionClaim;
    }
    return (await this.state.storage.get(baseKey)) || null;
  }

  /**
   * Следующая пачка: предыдущая ушла в задачу/отменена, время стартуем заново.
   * Возвращает ПРЕДЫДУЩИЙ batchId — его и надо закрыть наружу; новый появляется
   * только когда в него реально придёт сообщение.
   */
  async _nextBatchLocked(chatId, threadId) {
    const store = this.state.storage;
    const prev = await store.get(BATCH_KEY);
    // conversationKey нужен только как метка; если чата нет (/clear), берём её из
    // предыдущего пакета, иначе метка была бы 'null'.
    const ck = (chatId == null && prev?.conversationKey) || conversationKey(chatId, threadId);
    await store.put(BATCH_KEY, {
      batchId: `${ck}#${(prev?.seq ?? 0) + 1}`, seq: (prev?.seq ?? 0) + 1,
      conversationKey: ck, firstMessageAt: Date.now(),
    });
    return prev?.batchId ?? null;
  }

  /**
   * Сообщить control plane о накопленном пакете. BEST-EFFORT: сбой уходит в лог
   * и не имеет права ломать приём сообщения — иначе детектор, который мы строим,
   * сам станет причиной тишины.
   */
  async _announcePending(env, batch, { profileId, destinationId, prepState, deadlineMs } = {}) {
    if (!batch) return;
    // Сторожевой канал ОБЯЗАН быть безвредным. Здесь он зовётся из приёма и из
    // запуска; необработанное исключение из него превратилось бы в «сбой запуска»
    // (catch в _dispatch снимает busy) или в «приём не состоялся». Поэтому
    // весь вызов под футпринтом: наблюдаемость не имеет права влиять на приём
    // и запуск — ради этого её и делали.
    try {
      await this._registerPending(env, batch, { profileId, destinationId, prepState, deadlineMs });
    } catch (e) {
      console.warn(`[pending-intake] announce ${batch.batchId} threw: ${e.message}`);
    }
  }

  /** Закрытие пакета наружу — тоже под футпринтом, по тем же причинам. */
  async _closePending(env, batchId, reason, userTaskId = null) {
    try {
      await closePendingBatch(env, batchId, reason, userTaskId);
    } catch (e) {
      console.warn(`[pending-intake] close ${batchId} threw: ${e.message}`);
    }
  }

  async _registerPending(env, batch, { profileId, destinationId, prepState, deadlineMs } = {}) {
    if (!batch) return;
    await registerPendingBatch(env, {
      batchId: batch.batchId,
      profileId,
      destinationId: destinationId ?? null,
      conversationId: batch.conversationKey ?? null,
      firstMessageAt: batch.firstMessageAt,
      prepState,
      deadlineMs,
    });
  }

  async _exclusive(fn) {
    const previous = this.mutation;
    let release;
    this.mutation = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await fn(); } finally { release(); }
  }

  async _bumpDraftRevisionLocked(store = this.state.storage) {
    const previous = await store.get('draftRevision');
    const revision = (Number.isSafeInteger(previous) && previous > 0 ? previous : 0) + 1;
    await store.put('draftRevision', revision);
    return revision;
  }

  async _activeUnresolvedLaunches() {
    const keys = (await this.state.storage.get('cpUnresolvedLaunches')) || [];
    const active = [];
    for (const key of keys) {
      if (!(await this.state.storage.get(`cp-launch:${key}`))?.userDismissed) active.push(key);
    }
    return active;
  }

  async _callbackOwned(source) {
    try { return await this._callbackOwnedUnchecked(source); } catch { return false; }
  }

  async _callbackOwnedUnchecked(source) {
    const messageId = source.messageId ?? source.sourceMessageId;
    if (!Number.isSafeInteger(messageId) || messageId <= 0 || typeof source.username !== 'string') return false;
    const items = [...((await this.state.storage.get('retryBatch')) || []), ...((await this.state.storage.get('buf')) || [])];
    const last = items.at(-1)?.msg || (await this.state.storage.get('launching'))?.at(-1)?.msg;
    const chatId = last?.chat?.id ?? await this.state.storage.get('busyChatId');
    if (chatId == null) return false;
    const session = await getSession(this.env.SESSIONS, chatId, last ? threadIdOf(last) : await this.state.storage.get('busyThread'));
    if (session?.username !== source.username) return false;
    const data = source.callbackData;
    if (typeof data !== 'string') return false;
    const dismissUnknown = /^intake_dismiss_unknown\|([a-f0-9-]{36})$/.exec(data);
    if (dismissUnknown) {
      if (this.env.EXECUTION_BACKEND !== 'control-plane') {
        const action = await this.state.storage.get(`legacy-unknown-dismiss:${dismissUnknown[1]}`);
        return !!action && action.status === 'pending' && action.messageId === messageId &&
          action.username === source.username && action.chatId === chatId &&
          (await this.state.storage.get('busy')) === true && (await this._busyRequestIds()).includes(action.requestId);
      }
      const action = await this.state.storage.get(`cp-unknown-dismiss:${dismissUnknown[1]}`);
      return !!action && action.messageId === messageId && action.username === source.username &&
        action.intentId === (await this.state.storage.get('cpStopWindow'))?.intentId;
    }
    const styleLaunch = /^ws\|(explore|answer|auto)\|(\d+)$/.exec(data);
    if (/^intake_stop(yes|no)\|(supp|new)$/.test(data || '')) {
      const confirmation = await this.state.storage.get(`cp-confirmation:${messageId}`);
      const currentRequestIds = [...new Set((await this.state.storage.get('cpBusyRequests')) || [])].sort();
      return !!confirmation && confirmation.username === source.username && confirmation.mode === data.split('|')[1]
        && JSON.stringify(confirmation.requestIds || []) === JSON.stringify(currentRequestIds);
    }
    const collector = await this.state.storage.get('collectorMsgId');
    const preparing = await this.state.storage.get('preparingMsgId');
    if (data?.startsWith('stop|') || data?.startsWith('stopok|') || data?.startsWith('stopno|')) {
      if (messageId !== preparing || !(await this.state.storage.get('busy'))) return false;
      const taskId = data.split('|')[1];
      const snapshotRequestId = await this.state.storage.get(`input-message:${messageId}`);
      for (const requestId of (await this.state.storage.get('cpBusyRequests')) || []) {
        if (requestId !== snapshotRequestId) continue;
        const record = await this.state.storage.get(`cp-acceptance:${requestId}`);
        if (!record?.terminal && record?.receipt?.userTaskId === taskId) return true;
      }
      return false;
    }
    if (messageId !== collector || !items.length) return false;
    const queued = !!(await this.state.storage.get('launchQueued')) || !!(await this.state.storage.get('stopLaunch'));
    if (queued) return data === 'intake_cancel';
    if (/^intake_discard\|\d+$/.test(data)) return Number(data.split('|')[1]) === await this.state.storage.get('draftRevision');
    if (styleLaunch) return Number(styleLaunch[2]) === await this.state.storage.get('draftRevision');
      if (data === 'intake_run') return false; // CP collector buttons are revision-bound workStyle actions.
    if (['intake_parallel', 'intake_stopsupp', 'intake_stopnew'].includes(data)) return !!(await this.state.storage.get('busy'));
    return false;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (this.env.EXECUTION_BACKEND === 'control-plane' && url.pathname === '/discard' && request.method === 'POST') {
      const source = await request.clone().json().catch(() => ({}));
      const result = await this._exclusive(async () => {
        if (!(await this._callbackOwned(source))) return { refused: true };
        if (this.cpDispatches || (await this._activeUnresolvedLaunches()).length ||
            (await this.state.storage.get('launching'))?.length) {
          return { pending: true };
        }
        const buf = (await this.state.storage.get('buf')) || [];
        const retry = (await this.state.storage.get('retryBatch')) || [];
        if ([...buf, ...retry].some(item => item.mediaPending || item.preparingAt)) return { pending: true, preparing: true };
        const failedKeys = [...(await this.state.storage.list({ prefix: 'failed:' })).keys()];
        const failedMediaKeys = [...(await this.state.storage.list({ prefix: 'media-failed:' })).keys()];
        const failedCount = (await Promise.all(failedKeys.map(async key => (await this.state.storage.get(key))?.items?.length || 0)))
          .reduce((count, length) => count + length, 0);
        await this.state.storage.delete('buf');
        await this.state.storage.delete('retryBatch');
        await this.state.storage.delete('retryBatchAttempts');
        for (const key of [...failedKeys, ...failedMediaKeys]) await this.state.storage.delete(key);
        for (const key of ['debounceExpiresAt', 'gateLevel', 'shortDebounce', 'gateConsulted', 'receiptDue',
          'collectorMsgId', 'launchAfterRelease', 'launchWhenReady', 'launchQueued', 'launchParallel',
          'launchWorkStyle', 'launchWorkStyleSource', 'parkedAt', 'parkReoffers']) await this.state.storage.delete(key);
        await this.state.storage.deleteAlarm();
        await this._bumpDraftRevisionLocked();
        const batchId = await this._nextBatchLocked(null, null);
        return { discarded: true, count: buf.length + retry.length + failedCount + failedMediaKeys.length, batchId };
      });
      if (result.batchId) await this._closePending(this.env, result.batchId, 'cleared');
      if (result.refused || result.pending) return Response.json({ discarded: false, ...result }, { status: 409 });
      return json(result);
    }
    if (this.env.EXECUTION_BACKEND === 'control-plane' && request.method === 'POST' &&
        ['/flush', '/cancel', '/stop-launch'].includes(url.pathname)) {
      const source = await request.clone().json().catch(() => ({}));
      const allowed = await this._exclusive(async () => {
        if (this.cpCallbackInFlight || !(await this._callbackOwned(source))) return false;
        if (url.pathname === '/flush' && !['intake_parallel'].includes(source.callbackData) &&
            !/^ws\|(explore|answer|auto)\|\d+$/.test(source.callbackData || '')) return false;
        if (url.pathname === '/cancel' && source.callbackData !== 'intake_cancel') return false;
        if (url.pathname === '/stop-launch' && source.callbackData !== `intake_stopyes|${source.mode}`) return false;
        this.cpCallbackInFlight = true;
        return true;
      });
      if (!allowed) return new Response('Callback ownership mismatch', { status: 409 });
      try { return await this._fetch(request); } finally { this.cpCallbackInFlight = false; }
    }
    return this._fetch(request);
  }

  async _fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/dismiss-unknown' && request.method === 'POST') {
      const source = await request.json().catch(() => ({}));
      if (this.env.EXECUTION_BACKEND !== 'control-plane') {
        const result = await this._exclusive(async () => {
          if (!(await this._callbackOwned(source))) return { refused: true };
          const token = String(source.callbackData || '').split('|')[1];
          const actionKey = `legacy-unknown-dismiss:${token}`;
          const action = await this.state.storage.get(actionKey);
          const saved = action && await this.state.storage.get(`legacy-unknown:${token}`);
          if (!action || action.status !== 'pending' || !saved || saved.state !== 'unknown' ||
              action.messageId !== (source.messageId ?? source.sourceMessageId) || action.requestId !== saved.requestId) {
            return { refused: true };
          }
          await this.state.storage.put(actionKey, { ...action, status: 'dismissed', dismissedAt: Date.now() });
          await this.state.storage.put(`legacy-unknown:${token}`, { ...saved, userDismissedAt: Date.now() });
          const launching = (await this.state.storage.get('launching')) || [];
          if (JSON.stringify(launching.map(item => item.msg?.message_id)) === JSON.stringify(saved.messageIds)) {
            await this.state.storage.delete('launching');
          }
          const remaining = (await this._busyRequestIds()).filter(id => id !== action.requestId);
          if (remaining.length) await this.state.storage.put('busyRequestIds', remaining);
          else {
            await this.state.storage.delete('busyRequestIds');
            await this._releaseBusyLocked();
          }
          return { dismissed: true, chatId: saved.chatId, threadId: saved.threadId, released: !remaining.length };
        });
        if (result.refused) return new Response('Unknown task ownership mismatch', { status: 409 });
        await sendTracked(this.env, result.chatId,
          '⏸ Больше не жду подтверждения этой задачи в чате. Её исход остаётся неизвестным: агент мог её принять и продолжить. Повторно её не запускаю; новый ввод сохранён отдельно.',
          {}, result.threadId).catch(() => null);
        if (result.released) await this._afterBusyRelease();
        return json({ dismissed: true, outcomeUnknown: true });
      }
      const result = await this._exclusive(async () => {
        if (!(await this._callbackOwned(source))) return { refused: true };
        const token = String(source.callbackData || '').split('|')[1];
        const action = await this.state.storage.get(`cp-unknown-dismiss:${token}`);
        const checkpoint = action && await this.state.storage.get(`cp-launch:${action.launchKey}`);
        const window = await this.state.storage.get('cpStopWindow');
        const unresolved = (await this.state.storage.get('cpUnresolvedLaunches')) || [];
        if (!action || !checkpoint || !window?.pending || action.intentId !== window.intentId ||
            !unresolved.includes(action.launchKey) || !(window.admissionLaunchKeys || []).includes(action.launchKey)) return { refused: true };
        await this.state.storage.put(`cp-launch:${action.launchKey}`, { ...checkpoint, userDismissed: true, userDismissedAt: Date.now() });
        await this.state.storage.put('cpStopWindow', { ...window, userDismissedLaunchKeys:
          [...new Set([...(window.userDismissedLaunchKeys || []), action.launchKey])] });
        return { dismissed: true, chatId: window.chatId, threadId: window.threadId };
      });
      if (result.refused) return new Response('Unknown task ownership mismatch', { status: 409 });
      await sendTracked(this.env, result.chatId, '⏸ Больше не жду подтверждения старой задачи в этом чате. Её исход остаётся неизвестным: она могла запуститься и продолжиться. Повторно её не запускаю; новую задачу можно начать отдельно.', {}, result.threadId).catch(() => null);
      const buf = (await this.state.storage.get('buf')) || [];
      if (buf.length) await this._showCollector(result.chatId, buf.length, buf.at(-1)?.msg?.message_id, result.threadId);
      return json({ dismissed: true, outcomeUnknown: true });
    }
    if (controlPlaneStopDisabled(this.env) && request.method === 'POST'
        && ['/stop', '/cp-stop-targets', '/stop-launch', '/callback-confirmation', '/supplement'].includes(url.pathname)) {
      return Response.json({ error: 'control_plane_stop_disabled' }, { status: 409 });
    }
    if (url.pathname === '/cp-stop-targets' && request.method === 'POST') {
      if (this.env.EXECUTION_BACKEND !== 'control-plane') return new Response('Unavailable', { status: 404 });
      const source = await request.json().catch(() => null);
      try { await this._exclusive(async () => this._readControlPlaneStopTargets(source)); }
      catch { return new Response('Stop scope mismatch', { status: 409 }); }
      try { return json(await this._driveControlPlaneStop(source)); }
      catch {
        await this._exclusive(async () => {
          const current = await this.state.storage.get('cpStopWindow');
          if (current) {
            await this.state.storage.put('cpStopWindow', { ...current, pending: true, unresolved: true });
            await this.state.storage.setAlarm(Date.now() + BUSY_POLL_MS);
          }
        });
        return json({ unresolved: true, stopConfirmed: false, reason: 'native_stop_unknown' });
      }
    }
    if (this.env.EXECUTION_BACKEND === 'control-plane' && url.pathname === '/callback-owner' && request.method === 'POST') {
      const source = await request.json();
      return this._exclusive(async () => json({ owned: await this._callbackOwned(source) }));
    }
    if (this.env.EXECUTION_BACKEND === 'control-plane' && url.pathname === '/callback-confirmation' && request.method === 'POST') {
      const source = await request.json();
      return this._exclusive(async () => {
        if (!Number.isSafeInteger(source.messageId) || source.messageId <= 0 ||
            !['intake_stopsupp', 'intake_stopnew'].includes(source.callbackData) ||
            !(await this._callbackOwned({ ...source, messageId: source.sourceMessageId }))) {
          return new Response('Confirmation ownership mismatch', { status: 409 });
        }
        const value = { username: source.username, mode: source.callbackData === 'intake_stopsupp' ? 'supp' : 'new',
          sourceMessageId: source.sourceMessageId,
          requestIds: [...new Set((await this.state.storage.get('cpBusyRequests')) || [])].sort() };
        const key = `cp-confirmation:${source.messageId}`;
        const existing = await this.state.storage.get(key);
        if (existing && JSON.stringify(existing) !== JSON.stringify(value)) return new Response('Confirmation conflict', { status: 409 });
        await this.state.storage.put(key, value);
        return json({ owned: true });
      });
    }
    if (url.pathname === '/cp-session') {
      if (this.env.EXECUTION_BACKEND !== 'control-plane') return new Response('Unavailable', { status: 404 });
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      const { requestId, sessionId } = await request.json();
      if (typeof requestId !== 'string' || !/^tg-[a-f0-9]{64}$/.test(requestId) ||
          typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 256) {
        return new Response('Invalid session identity', { status: 400 });
      }
      return this._exclusive(async () => {
        const profileId = controlPlaneClient(this.env).config.profileId;
        return this.state.storage.transaction(async tx => {
          const key = `cp-session:${requestId}`;
          const existing = await tx.get(key);
          if (existing && existing.profileId !== profileId) return new Response('Session scope mismatch', { status: 409 });
          const value = existing || { requestId, sessionId, profileId };
          if (!existing) await tx.put(key, value);
          return json({ sessionId: value.sessionId });
        });
      });
    }
    if (url.pathname === '/cp-acceptance') {
      if (this.env.EXECUTION_BACKEND !== 'control-plane') return new Response('Unavailable', { status: 404 });
      if (request.method === 'GET') {
        const record = await this.state.storage.get(`cp-acceptance:${url.searchParams.get('requestId')}`);
        return json({ receipt: record?.receipt ?? null });
      }
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      const { requestId, receipt } = await request.json();
      return this._exclusive(async () => {
        const snapshot = typeof requestId === 'string' && await this._readSnapshot(requestId);
        const envelope = snapshot?.body?.controlPlaneEnvelope;
        let profileId;
        try {
          profileId = controlPlaneClient(this.env).config.profileId;
        } catch {
          return new Response('Control plane configuration unavailable', { status: 503 });
        }
        if (!requestId || !envelope || envelope.requestId !== requestId ||
            receipt?.requestId !== requestId || receipt?.profileId !== envelope.profileId || receipt?.profileId !== profileId ||
            typeof receipt?.userTaskId !== 'string' || !receipt.userTaskId || receipt.durable !== true) {
          return new Response('Acceptance scope mismatch', { status: 409 });
        }
        const key = `cp-acceptance:${requestId}`;
        const existing = await this.state.storage.get(key);
        if (existing) {
          if (existing.receipt.userTaskId !== receipt.userTaskId || existing.receipt.profileId !== receipt.profileId ||
              existing.receipt.requestId !== requestId) return new Response('Acceptance conflict', { status: 409 });
          return json({ receipt: existing.receipt });
        }
        await this.state.storage.transaction(async tx => {
          await tx.put(key, { receipt, terminal: false });
          const ids = (await tx.get('cpBusyRequests')) || [];
          await tx.put('cpBusyRequests', [...new Set([...ids, requestId])]);
          await tx.put('busy', true);
          await tx.setAlarm(Date.now() + BUSY_POLL_MS);
        });
        return json({ receipt });
      });
    }

    // Strongly-consistent mirror of the chat's project picker (src/lib/picker-mirror.js).
    // Deliberately outside _exclusive(): the flush that opens the picker calls here
    // while holding it, and a picker read must never wait behind a long dispatch.
    if (url.pathname === '/picker') {
      if (request.method === 'GET') return Response.json({ pending: (await this.state.storage.get('picker')) || null });
      if (request.method === 'PUT') {
        const { pending } = await request.json();
        if (pending) await this.state.storage.put('picker', pending);
        else await this.state.storage.delete('picker');
        return Response.json({ ok: true });
      }
    }

    // «➕ Дополнить» collector (src/lib/supplement.js). Lives here, not in SESSIONS KV:
    // the webhook routes the typed text to this DO anyway, and only strongly-consistent
    // per-conversation storage makes a burst (text + voice + file within a second)
    // land in ONE draft. Outside _exclusive() like /picker — every op is a
    // storage-only read-modify-write with no external I/O, so it is atomic in a DO and
    // must never wait behind a long dispatch holding the intake mutex.
    if (url.pathname === '/supplement' && request.method === 'POST') {
      return json(await this._supplement(await request.json()));
    }

    if (url.pathname === '/input' && request.method === 'GET') {
      const statusId = url.searchParams.get('messageId');
      const snapshotId = statusId && await this.state.storage.get(`input-message:${statusId}`);
      if (snapshotId) {
        const snapshot = await this._readSnapshot(snapshotId);
        if (snapshot?.body.username !== url.searchParams.get('username')) return new Response('Forbidden', { status: 403 });
        return json(snapshot);
      }
      const preparing = statusId && String(await this.state.storage.get('preparingMsgId')) === statusId;
      if (url.searchParams.get('draft') !== 'true' && !preparing) return new Response('Snapshot not found', { status: 404 });
      const items = preparing ? ((await this.state.storage.get('launching')) || (await this.state.storage.get('retryBatch')) || [])
        : [...((await this.state.storage.get('retryBatch')) || []), ...((await this.state.storage.get('buf')) || [])];
      if (!items.length) return new Response('Input not found', { status: 404 });
      items
        .sort((a, b) => (a.msg.message_id || 0) - (b.msg.message_id || 0));
      return json({ state: 'draft', items, ...assembleInput(items),
        pending: !!preparing || items.some(i => i.mediaPending || i.preparingAt) });
    }
    if (url.pathname === '/snapshot' && request.method === 'POST') {
      const { body, items } = await request.json();
      return this._exclusive(async () => {
        const id = body.requestId;
        if (!id) return new Response('requestId required', { status: 400 });
        const existing = await this._readSnapshot(id);
        if (existing && existing.body.username !== body.username) return new Response('Snapshot owner mismatch', { status: 403 });
        if (!existing) {
          const data = JSON.stringify({ state: 'snapshot', id, createdAt: Date.now(), items, body });
          const chunks = Math.ceil(data.length / 16000);
          await this.state.storage.transaction(async tx => {
            for (let i = 0; i < chunks; i++) await tx.put(`input:${id}:${i}`, data.slice(i * 16000, (i + 1) * 16000));
            await tx.put(`input:${id}`, { chunks });
          });
        }
        if (body.initialMsgId) await this.state.storage.put(`input-message:${body.initialMsgId}`, id);
        if (this.env.EXECUTION_BACKEND === 'control-plane' && (existing?.body || body).controlPlaneEnvelope) {
          const launchKey = JSON.stringify((existing?.items || items || []).map(item => item.msg?.message_id));
          const checkpoint = await this.state.storage.get(`cp-launch:${launchKey}`);
          if (checkpoint) await this.state.storage.put(`cp-launch:${launchKey}`, { ...checkpoint, snapshotRequestId: id });
        }
        return json({ id, body: existing?.body || body });
      });
    }

    if (url.pathname === '/group-history') {
      if (request.method === 'GET') {
        if (await this.state.storage.get('groupHistoryOff')) return json({ enabled: false, entries: [], delivered: 0 });
        const delivered = (await this.state.storage.get('groupHistoryDelivered')) || 0;
        let entries = pruneHistory((await this.state.storage.get('groupHistory')) || []);
        // ?pending=1 → only what no accepted run has carried yet (seq-less legacy entries
        // count as seq 0: pending until the first ack).
        if (url.searchParams.get('pending')) entries = entries.filter(e => (e.seq || 0) > delivered || (!e.seq && !delivered));
        return json({ enabled: true, entries, delivered });
      }
      if (request.method === 'POST') {
        const { entry } = await request.json();
        return this._historyExclusive(async () => {
          if (await this.state.storage.get('groupHistoryOff')) return json({ recorded: false, enabled: false });
          if (!entry?.text || !Number.isFinite(entry.ts)) return new Response('entry required', { status: 400 });
          const seq = ((await this.state.storage.get('groupHistorySeq')) || 0) + 1;
          const entries = pruneHistory([...((await this.state.storage.get('groupHistory')) || []), { ...entry, seq }]);
          await this.state.storage.put('groupHistorySeq', seq);
          await this.state.storage.put('groupHistory', entries);
          return json({ recorded: true, count: entries.length, seq });
        });
      }
    }
    if (url.pathname === '/group-history/ack' && request.method === 'POST') {
      const { seq } = await request.json();
      if (!Number.isSafeInteger(seq) || seq < 1) return new Response('seq required', { status: 400 });
      return this._historyExclusive(async () => {
        const delivered = Math.max((await this.state.storage.get('groupHistoryDelivered')) || 0, seq);
        await this.state.storage.put('groupHistoryDelivered', delivered);
        return json({ delivered });
      });
    }
    if (url.pathname === '/group-history/mode' && request.method === 'POST') {
      const { enabled } = await request.json();
      return this._historyExclusive(async () => {
        const wasEnabled = !(await this.state.storage.get('groupHistoryOff'));
        if (enabled) await this.state.storage.delete('groupHistoryOff');
        else {
          await this.state.storage.put('groupHistoryOff', true);
          await this.state.storage.delete('groupHistory');
        }
        return json({ wasEnabled, enabled: !!enabled });
      });
    }

    if (url.pathname === '/debug' && request.method === 'GET') {
      const [buf, retryBatch, retryBatchAttempts, busy, busySince, launching, debounceExpiresAt, gateLevel,
        receiptDue, collectorMsgId, gateConsulted, gateErrAttempts, parkedAt, parkReoffers] =
        await Promise.all([
          this.state.storage.get('buf'), this.state.storage.get('retryBatch'),
          this.state.storage.get('retryBatchAttempts'), this.state.storage.get('busy'),
          this.state.storage.get('busySince'), this.state.storage.get('launching'),
          this.state.storage.get('debounceExpiresAt'), this.state.storage.get('gateLevel'),
          this.state.storage.get('receiptDue'), this.state.storage.get('collectorMsgId'),
          this.state.storage.get('gateConsulted'), this.state.storage.get('gateErrAttempts'),
          this.state.storage.get('parkedAt'), this.state.storage.get('parkReoffers'),
        ]);
      // `alarm` answers the one question the old dump could not: is anything at all
      // still scheduled for this chat, or is it asleep? A non-empty buffer with no
      // alarm and no busy IS the dead-end (#248, chat -1003814002203).
      const alarm = await this.state.storage.getAlarm();
      const unresolvedLaunches = (await this.state.storage.get('cpUnresolvedLaunches')) || [];
      const busyRequests = (await this.state.storage.get('cpBusyRequests')) || [];
      const stopWindow = await this.state.storage.get('cpStopWindow');
      const unresolvedCheckpointMedia = await Promise.all(unresolvedLaunches.map(async key => {
        const checkpoint = await this.state.storage.get(`cp-launch:${key}`);
        const items = checkpoint?.msg?.intakeItems || (checkpoint?.msg ? [{ msg: checkpoint.msg }] : []);
        return items.some(item => !!mediaOf(item.msg) && !item.msg?.fileRef);
      }));
      const summarize = items => (items || []).map(i => ({
        messageId: i.msg?.message_id, hasText: !!i.text, mediaPending: !!i.mediaPending,
        mediaJob: i.msg?.mediaJob, fileRefStorage: i.msg?.fileRef?.storage,
        preparingAt: i.preparingAt, enqueueFailures: i.enqueueFailures || 0,
      }));
      const cursor = url.searchParams.get('cursor');
      const failed = await this.state.storage.list({ prefix: 'failed:', limit: 100,
        ...(cursor && /^failed:[a-f0-9-]{36}$/.test(cursor) ? { startAfter: cursor } : {}) });
      return json({
        failedBatchesNextCursor: failed.size === 100 ? [...failed.keys()].at(-1) : null,
        failedBatches: [...failed.values()].map(({ id, items, failedAt, messageId, status }) =>
          ({ id, failedAt, messageId, status, items: summarize(items) })),
        buf: summarize(buf), retryBatch: summarize(retryBatch), retryBatchAttempts: retryBatchAttempts || 0,
        busy: !!busy, busySince: busySince || null, launching: summarize(launching),
        debounceExpiresAt: debounceExpiresAt || null, gateLevel: gateLevel || null,
        alarm: alarm || null, receiptDue: receiptDue || null, collectorMsgId: collectorMsgId || null,
        gateConsulted: !!gateConsulted, gateErrAttempts: gateErrAttempts || 0,
        parkedAt: parkedAt || null, parkReoffers: parkReoffers || 0,
        stopped: (await this.state.storage.get('stopped')) || null,
        controlPlaneBarrier: this.env.EXECUTION_BACKEND === 'control-plane' ? {
          unresolvedLaunchCount: unresolvedLaunches.length,
          unresolvedCheckpointHasUnsupportedMedia: unresolvedCheckpointMedia.some(Boolean),
          busyRequestCount: busyRequests.length,
          stopPending: stopWindow?.pending === true,
        } : null,
        collectorDelivery: this.env.EXECUTION_BACKEND === 'control-plane'
          ? await this._readCollectorDelivery(stopWindow, [...(retryBatch || []), ...(buf || [])])
          : null,
        // A parked batch is an intentional wait for ▶️ (visible, one re-offer) —
        // not a dead-end. `stranded` now means: buffer non-empty, nothing
        // scheduled, and NOT parked = genuinely lost.
        stranded: !busy && ((buf || []).length > 0) && !alarm && !debounceExpiresAt && !receiptDue
          && !(await this.state.storage.get('stopped')) && !parkedAt,
      });
    }

    if (url.pathname === '/restore' && request.method === 'POST') {
      const { id } = await request.json();
      if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) return new Response('invalid id', { status: 400 });
      return this._exclusive(async () => this.state.storage.transaction(async tx => {
        if (await tx.get('busy') || (await tx.get('retryBatch'))?.length) return new Response('busy', { status: 409 });
        const batch = await tx.get(`failed:${id}`);
        if (!batch) return new Response('not found', { status: 404 });
        await tx.put('retryBatch', batch.items);
        await tx.delete('retryBatchAttempts');
        await tx.delete(`failed:${id}`);
        // No task, alarm or Telegram notification is triggered by restoration.
        return json({ restored: true, count: batch.items.length });
      }));
    }

    // Explicit escape hatch (Telegram /clean_buffer): drop everything buffered for
    // this chat — buf, retryBatch, failed batches and any pending debounce/alarm —
    // WITHOUT touching an in-flight run. Fixes the "messages sit in the buffer
    // forever, no button, no ack" dead-end (e.g. the gate saying 'insufficient'
    // and never re-offering a launch). Never launches anything.
    if (url.pathname === '/clear' && request.method === 'POST') {
      if (await this.state.storage.get('busy')) return json({ busy: true, cleared: false });
      let clearedBatchId = null;
      const result = await this._exclusive(async () => {
        const buf = (await this.state.storage.get('buf')) || [];
        const retry = (await this.state.storage.get('retryBatch')) || [];
        const failedKeys = [...(await this.state.storage.list({ prefix: 'failed:' })).keys()];
        await this.state.storage.delete('buf');
        await this.state.storage.delete('retryBatch');
        await this.state.storage.delete('retryBatchAttempts');
        for (const k of failedKeys) await this.state.storage.delete(k);
        await this.state.storage.delete('debounceExpiresAt');
        await this.state.storage.delete('gateLevel');
        await this.state.storage.delete('shortDebounce');
        await this.state.storage.delete('gateConsulted');
        await this.state.storage.delete('receiptDue');
        await this.state.storage.delete('collectorMsgId');
        await this.state.storage.delete('launching');
        await this.state.storage.delete('launchAfterRelease');
        await this.state.storage.delete('launchWhenReady');
        await this.state.storage.delete('launchQueued');
        await this.state.storage.delete('stopped');
        await this.state.storage.delete('resumedHeld');
        await this.state.storage.delete('parkedAt');
        await this.state.storage.delete('parkReoffers');
        await this.state.storage.deleteAlarm();
        clearedBatchId = await this._nextBatchLocked(null, null);
        return { cleared: buf.length + retry.length, failed: failedKeys.length };
      });
      // Решение пользователя/оператора — это НЕ «зависший ввод» (arch#132 R9):
      // иначе детектор через 30 минут напомнил бы про пакет, который сняли.
      await this._closePending(this.env, clearedBatchId, 'cleared');
      return json(result);
    }

    // ⛔ Стоп (#1856) — /stop, /стоп and the ⛔ button call this BEFORE the agent's
    // /tasks/stop, so it works even when the agent has nothing running. In prod
    // (29.09) most stops landed between runs: the agent killed 0 processes and the
    // gateway then launched the next buffered batch anyway — via run-finished →
    // _afterBusyRelease (launchAfterRelease), the judge's debounce alarm (30 s /
    // 3 min) or a remembered ▶️ (launchWhenReady). Stop therefore:
    //   • drops every launch intent and the judge timer/verdict state;
    //   • marks the chat `stopped` — _afterBusyRelease / alarm / _mediaResult
    //     never auto-dispatch while it is set;
    //   • KEEPS the messages and shows «⛔ Остановлено. N ждут — ▶️».
    // Only an explicit ▶️ (/flush) or a NEW message after the stop clears it.
    if (url.pathname === '/stop' && request.method === 'POST') {
      const source = await request.json().catch(() => ({}));
      const { replyTo = null, chatId: reqChatId = null, threadId: reqThreadId = null, preserveDraft = false } = source;
      const res = await this._exclusive(async () => {
        const store = this.state.storage;
        if (this.env.EXECUTION_BACKEND === 'control-plane') {
          try {
            const session = await getSession(this.env.SESSIONS, reqChatId, reqThreadId);
            const username = source.username ?? session?.username;
            const profileId = controlPlaneClient(this.env).config.profileId;
            const scope = await store.get('cpScope');
            if (!username || session?.username !== username || !scope || scope.chatId !== reqChatId
              || scope.threadId !== reqThreadId || scope.profileId !== profileId) return null;
            const previous = await store.get('cpStopWindow');
            if (!previous?.pending) {
              const admissionRequestIds = [...new Set(await store.get('cpBusyRequests') || [])].sort();
              await store.put('cpStopWindow', { intentId: crypto.randomUUID(), restart: previous?.stopConfirmed === true,
                username, chatId: reqChatId, threadId: reqThreadId, profileId,
                preserveDraft: preserveDraft === true,
                previousGroups: previous?.groups || [], admissionRequestIds,
                admissionLaunchKeys: [...(await store.get('cpUnresolvedLaunches') || [])], groups: [], tasks: [],
                pending: true, unresolved: true, stopConfirmed: false,
                createdAt: Date.now() });
            }
          } catch { return null; }
        }
        const had = !!((await store.get('launchAfterRelease')) || (await store.get('launchWhenReady'))
          || (await store.get('launchQueued')) || (await store.get('debounceExpiresAt')));
        for (const k of ['launchAfterRelease', 'launchWhenReady', 'launchQueued', 'launchWorkStyle', 'launchWorkStyleSource', 'debounceExpiresAt',
          'gateLevel', 'shortDebounce', 'gateConsulted', 'gateErrAttempts', 'receiptDue', 'resumedHeld',
          'parkedAt', 'parkReoffers']) {
          await store.delete(k);
        }
        await store.put('stopped', Date.now());
        const busy = !!(await store.get('busy'));
        const items = [...((await store.get('retryBatch')) || []), ...((await store.get('buf')) || [])];
        const failedKeys = this.env.EXECUTION_BACKEND === 'control-plane'
          ? [...(await store.list({ prefix: 'failed:' })).keys()] : [];
        const failedMediaKeys = this.env.EXECUTION_BACKEND === 'control-plane'
          ? [...(await store.list({ prefix: 'media-failed:' })).keys()] : [];
        const failedDraftCount = (await Promise.all(failedKeys.map(async key => (await store.get(key))?.items?.length || 0)))
          .reduce((count, length) => count + length, 0) + failedMediaKeys.length;
        const preserveSelectedDraft = preserveDraft === true || (await store.get('cpStopWindow'))?.preserveDraft === true;
        const resetControlPlaneDraft = this.env.EXECUTION_BACKEND === 'control-plane' && !preserveSelectedDraft;
        const clearedDraftCount = resetControlPlaneDraft ? items.length + failedDraftCount : 0;
        if (resetControlPlaneDraft) {
          await store.delete('buf');
          await store.delete('retryBatch');
          await store.delete('retryBatchAttempts');
          await store.delete('launchParallel');
          await store.delete('launchWorkStyle');
          await store.delete('launchWorkStyleSource');
          for (const key of [...failedKeys, ...failedMediaKeys]) await store.delete(key);
          await this._bumpDraftRevisionLocked();
        }
        // The alarm only stays for what is not a launch: the busy safety poll and
        // media recovery. Everything else it could do now is dispatch.
        if (this.env.EXECUTION_BACKEND === 'control-plane' && (await store.get('cpStopWindow'))?.pending) await store.setAlarm(Date.now() + BUSY_POLL_MS);
        else if (busy) await store.setAlarm(Date.now() + BUSY_POLL_MS);
        else if (items.some(i => i.mediaPending)) await store.setAlarm(Date.now() + 60_000);
        else await store.deleteAlarm();
        const prevCollector = items.length ? await store.get('collectorMsgId') : null;
        if (prevCollector) await store.delete('collectorMsgId');
        const clearedBatchId = resetControlPlaneDraft && clearedDraftCount
          ? await this._nextBatchLocked(items.at(-1)?.msg?.chat?.id, threadIdOf(items.at(-1)?.msg)) : null;
        const independentBatchId = resetControlPlaneDraft && clearedDraftCount && (await store.get('cpStopWindow'))?.pending
          ? (await this._batchIdLocked(reqChatId, reqThreadId)).batchId : null;
        return { held: resetControlPlaneDraft ? 0 : items.length, clearedDraftCount, busy, hadIntent: had, prevCollector,
          last: items.at(-1)?.msg || null, clearedBatchId, independentBatchId };
      });
      if (res === null) return new Response('Stop scope mismatch', { status: 409 });
      if (res.clearedBatchId) await this._closePending(this.env, res.clearedBatchId, 'cleared');
      if (res.independentBatchId) await this._announcePending(this.env, { batchId: res.independentBatchId }, {
        profileId: source.username, destinationId: String(reqChatId), prepState: 'collecting',
        deadlineMs: PENDING_BATCH_DEADLINE_MS,
      });
      console.log(`[stop] intake chat=${res.last?.chat?.id ?? reqChatId} held=${res.held} busy=${res.busy} hadIntent=${res.hadIntent}`);
      if (res.held) {
        const chatId = res.last?.chat?.id ?? reqChatId;
        const threadId = res.last ? threadIdOf(res.last) : reqThreadId;
        // The old collector may sit off-screen with ▶️/↩️ on it: neutralise it and
        // post a fresh one right under the stop, where the user is looking.
        if (res.prevCollector && chatId) {
          await editMessage(this.env.BOT_TOKEN, chatId, res.prevCollector, '⏸ Порция отложена — статус остановки проверяется, см. ниже.',
            { reply_markup: { inline_keyboard: [] } }).catch(() => null);
        }
        await this._showCollector(chatId, res.held, replyTo || res.last?.message_id, threadId);
      }
      return json({ stopped: true, held: res.held, clearedDraftCount: res.clearedDraftCount,
        busy: res.busy, hadIntent: res.hadIntent });
    }

    if (url.pathname === '/media-result' && request.method === 'POST') {
      return this._mediaResult(await request.json());
    }

    // Agent → gateway run-finished (epic #1527 PR1): the primary release signal
    // for the busy hold. The agent pushes this when an admitted run settles
    // (success/error/stop/quick); the sender matches the busy request-id set so a foreign
    // run for the same chat can't release this chat's hold. Safety nets if this
    // never arrives: outbox permanent reject, the alarm's /tasks/running poll,
    // and BUSY_MAX_MS.
    // Live inbox (owner 2026-09-29, «get_new_messages»): while a run is busy, `buf`
    // holds exactly the messages that arrived after it started (_dispatch clears it).
    // The running model pulls them through the agent's MCP tool instead of ending
    // with «жду от тебя…». Read-only, outside _exclusive() like /picker: a single
    // storage read is atomic and must never wait behind a long dispatch.
    if (url.pathname === '/held' && request.method === 'GET') {
      if (!(await this.state.storage.get('busy'))) return json({ busy: false, items: [] });
      const requestId = url.searchParams.get('requestId');
      const busyIds = await this._busyRequestIds();
      // Another run of this chat holds the buffer — its messages are not ours to read.
      if (requestId && busyIds.length && !busyIds.includes(requestId)) return json({ busy: true, mismatch: true, items: [] });
      const buf = (await this.state.storage.get('buf')) || [];
      return json({ busy: true, busySince: (await this.state.storage.get('busySince')) || null, items: buf.map(heldView) });
    }

    if (url.pathname === '/run-finished' && request.method === 'POST') {
      if (this.env.EXECUTION_BACKEND === 'control-plane') {
        const released = await this._pollRunFinishedIfIdle(0);
        return json({ busy: !released && !!(await this.state.storage.get('busy')), released });
      }
      const { requestId = null, consumed = [] } = await request.json().catch(() => ({}));
      const consumedIds = new Set((Array.isArray(consumed) ? consumed : []).filter(Number.isSafeInteger));
      const released = await this._exclusive(async () => {
        if (!(await this.state.storage.get('busy'))) return { busy: false };
        const ids = await this._busyRequestIds();
        if (requestId && ids.length && !ids.includes(requestId)) return { busy: true, mismatch: true };
        // Messages the model already took in via get_new_messages are done — drop
        // them so the collector doesn't re-offer them as a new task. Only for the
        // matched run, and only ready items (a still-downloading attachment stays).
        let dropped = 0;
        if (consumedIds.size) {
          const buf = (await this.state.storage.get('buf')) || [];
          const kept = buf.filter(i => i.mediaPending || i.preparingAt || !consumedIds.has(i.msg?.message_id));
          dropped = buf.length - kept.length;
          if (dropped) await this.state.storage.put('buf', kept);
        }
        // One window may cover several live runs (explicit «⚡ Параллельно»,
        // RC-03): the hold is released only when the LAST of them reports in.
        // requestId-less pushes keep their legacy meaning — release everything.
        const remaining = requestId ? ids.filter(id => id !== requestId) : [];
        if (remaining.length) {
          await this.state.storage.put('busyRequestIds', remaining);
          return { busy: true, stillRunning: true, dropped };
        }
        await this._releaseBusyLocked();
        return { busy: false, released: true, dropped };
      });
      if (released.released) await this._afterBusyRelease();
      return json(released);
    }

    if (url.pathname === '/ingest' && request.method === 'POST') {
      let { msg } = await request.json();
      const diverted = await this._divertToSupplement(msg, '/ingest');
      if (diverted) return diverted;
      if (mediaEnabled(this.env) && mediaOf(msg)) {
        const session = await getSession(this.env.SESSIONS, msg.chat.id, threadIdOf(msg));
        if (session) return this._ingestMedia(msg, session);
      }
      // Reserve BEFORE STT/network awaits: launch must not silently omit a slow voice.
      // reservedAt decides later whether a ⛔ Стоп pressed during preflight holds
      // this message (sent before the stop) or it re-arms the flow (sent after).
      const reservedAt = Date.now();
      const accepted = await this._exclusive(async () => {
        const items = (await this.state.storage.get('buf')) || [];
        const seen = (await this.state.storage.get('received')) || [];
        if (seen.includes(msg.message_id) || items.some(i => i.msg.message_id === msg.message_id)) return false;
        items.push({ text: msg.text, msg, preparingAt: Date.now() });
        await this.state.storage.put('buf', items);
        await this._bumpDraftRevisionLocked();
        return true;
      });
      if (!accepted) return json({ duplicate: true });
      await this._scheduleReceipt();
      let result = { msg };
      try {
        const { preflight } = await import('./intake-preflight.js');
        result = await preflight({ ...msg, batchInput: true }, this.env, async prepared => {
          msg = prepared;
          result = { msg: prepared };
          await this._exclusive(async () => {
            const items = (await this.state.storage.get('buf')) || [];
            const index = items.findIndex(i => i.msg.message_id === prepared.message_id);
            if (index >= 0) items[index] = { ...items[index], msg: prepared };
            await this.state.storage.put('buf', items);
          });
        });
      } catch (error) {
        await sendTracked(this.env, msg.chat.id,
          '⚠️ Сообщение сохранено для повтора, но подготовка файла или расшифровки ещё не завершена. Повторю при запуске проработки.',
          {}, threadIdOf(msg));
        console.warn('[intake prepare]', error.message);
      }
      // `armSeq` is a monotonic claim token: two attachments whose slow preflight()
      // overlaps (a realistic "two voice notes within a second" burst) used to each
      // read `buf`/`busy` OUTSIDE any lock here and independently call
      // _armAutoDispatch — duplicate collector bubbles, the earlier one reporting a
      // stale count (regression test: "two ingests whose preflight overlaps...").
      // Committing the write AND claiming the next token happen atomically, so only
      // the call that turns out to be the LAST one committed (checked just below,
      // itself lock-protected but I/O-free) actually sends — see the file-level
      // comment on why the send itself still happens outside the lock.
      const claim = await this._exclusive(async () => {
        const items = (await this.state.storage.get('buf')) || [];
        const index = items.findIndex(i => i.msg.message_id === msg.message_id);
        if (index >= 0) {
          if (result.handled) items.splice(index, 1);
          else items[index] = { text: result.msg.text, msg: result.msg, intentText: msg.text || msg.caption || '' };
        }
        await this.state.storage.put('buf', items);
        await this._bumpDraftRevisionLocked();
        const seen = (await this.state.storage.get('received')) || [];
        await this.state.storage.put('received', [...seen, msg.message_id].slice(-1000));
        const seq = ((await this.state.storage.get('armSeq')) || 0) + 1;
        await this.state.storage.put('armSeq', seq);
        const stopped = await this.state.storage.get('stopped');
        const heldByStop = !!stopped && reservedAt <= stopped;
        if (stopped && !heldByStop && !result.handled) await this._resumeAfterStopLocked(msg.message_id);
        const busy = !!(await this.state.storage.get('busy'));
        // RC-06: input that sat in the buffer WHILE a run was going is the user's
        // unanswered batch — after the run ends it waits for an explicit choice,
        // never for the quiet-period gate (which would start it on its own). Mark
        // it here, atomically with the write, so the gate's decision after the
        // release can tell «held during a run» from «ordinary idle input».
        if (busy) {
          const marked = items.map(i => (i.heldWhileBusy ? i : { ...i, heldWhileBusy: true }));
          await this.state.storage.put('buf', marked);
          return { items: marked, busy, seq, heldByStop };
        }
        return { items, busy, seq, heldByStop };
      });
      if (result.handled) return json({ handled: true });
      if (!claim.items.length) return json({ buffered: 0 });
      if (claim.heldByStop) {
        // Sent before ⛔ — joins the held batch; the stopped collector counts it.
        await this._scheduleReceipt();
        return json({ buffered: claim.items.length, stopped: true });
      }
      if (claim.busy) {
        await this._showHeldNotice(msg.chat.id, claim.items.length, msg.message_id, threadIdOf(msg));
        return json({ buffered: claim.items.length });
      }
      const stillFreshest = await this._exclusive(async () => (await this.state.storage.get('armSeq')) === claim.seq);
      if (stillFreshest) await this._armAutoDispatch(msg.chat.id, claim.items, msg.message_id, threadIdOf(msg));
      // Наружу: «у меня накоплено вот это» (arch#132 R9). Время первого сообщения
      // пакета НЕ перебивается новыми — иначе возраст самого старого ввода
      // подменялся бы свежими.
      const batch = await this._exclusive(async () => this._batchIdLocked(msg.chat.id, threadIdOf(msg)));
      const session = await getSession(this.env.SESSIONS, msg.chat.id, threadIdOf(msg)).catch(() => null);
      await this._announcePending(this.env, batch, {
        profileId: session?.username ?? null,
        destinationId: String(msg.chat.id),
        prepState: 'collecting',
        deadlineMs: PENDING_BATCH_DEADLINE_MS,
      });
      return json({ buffered: claim.items.length });
    }

    if (url.pathname === '/append' && request.method === 'POST') {
      const { text, msg, flush, telegramUpdateId } = await request.json();
      const diverted = await this._divertToSupplement(msg, '/append');
      if (diverted) return diverted;
      const cpMode = this.env.EXECUTION_BACKEND === 'control-plane';
      const pendingStopWindow = cpMode && (await this.state.storage.get('cpStopWindow'))?.pending === true;
      const unsupportedMedia = cpMode && !!mediaOf(msg) && !mediaEnabled(this.env);
      let heldBehindPendingUnsupportedLaunch = false;
      const hasUnsupportedUnresolvedLaunch = async () => {
        if (!cpMode || mediaEnabled(this.env)) return false;
        const unresolved = (await this.state.storage.get('cpUnresolvedLaunches')) || [];
        for (const launchKey of unresolved) {
          const checkpoint = await this.state.storage.get(`cp-launch:${launchKey}`);
          const items = checkpoint?.msg?.intakeItems || (checkpoint?.msg ? [{ msg: checkpoint.msg }] : []);
          if (items.some(item => !!mediaOf(item.msg) && !item.msg?.fileRef)) return true;
        }
        return false;
      };
      const hasUnsupportedDraft = async () => cpMode && !mediaEnabled(this.env) &&
        [...((await this.state.storage.get('retryBatch')) || []), ...((await this.state.storage.get('buf')) || []),
          ...((await this.state.storage.get('launching')) || [])]
          .some(item => !!mediaOf(item.msg) && !item.msg?.fileRef) || await hasUnsupportedUnresolvedLaunch();
      // Reconcile an orphaned admission checkpoint whenever the user sends a
      // fresh text. It may outlive `launching` after a cold restart, so tying
      // recovery only to a visible unsupported-media draft can wedge the chat.
      if (cpMode && !mediaOf(msg) && !this.cpDispatches &&
          ((await this.state.storage.get('cpUnresolvedLaunches')) || []).length) {
        await this._recoverControlPlaneLaunch().catch(() => false);
      }
      let oldUnsupported = !mediaOf(msg) && await hasUnsupportedDraft();
      if (unsupportedMedia || oldUnsupported) {
        const reset = await this._exclusive(async () => {
          const busy = !!(await this.state.storage.get('busy'));
          if (this.cpDispatches || ((await this.state.storage.get('cpUnresolvedLaunches')) || []).length ||
              (await this.state.storage.get('launching'))?.length || (await this.state.storage.get('cpStopWindow'))?.pending) return { state: 'pending' };
          if (unsupportedMedia && busy) return { state: 'busy' };
          if (oldUnsupported && busy) {
            const buf = (await this.state.storage.get('buf')) || [];
            const retry = (await this.state.storage.get('retryBatch')) || [];
            await this.state.storage.put('buf', buf.filter(item => !mediaOf(item.msg) || item.msg?.fileRef));
            if (retry.some(item => !!mediaOf(item.msg) && !item.msg?.fileRef)) {
              await this.state.storage.delete('retryBatch');
              await this.state.storage.delete('retryBatchAttempts');
            }
            await this.state.storage.delete('collectorMsgId');
            await this._bumpDraftRevisionLocked();
            return { state: 'held-cleaned' };
          }
          await this.state.storage.delete('buf');
          await this.state.storage.delete('retryBatch');
          await this.state.storage.delete('retryBatchAttempts');
          for (const key of ['debounceExpiresAt', 'gateLevel', 'shortDebounce', 'gateConsulted', 'receiptDue',
            'collectorMsgId', 'launchAfterRelease', 'launchWhenReady', 'launchQueued', 'launchParallel',
            'launchWorkStyle', 'launchWorkStyleSource', 'parkedAt', 'parkReoffers']) await this.state.storage.delete(key);
          await this.state.storage.deleteAlarm();
          await this._bumpDraftRevisionLocked();
          const batchId = await this._nextBatchLocked(null, null);
          return { state: 'cleared', batchId };
        });
        if (reset.batchId) await this._closePending(this.env, reset.batchId, 'cleared');
        if (unsupportedMedia) {
          await sendTracked(this.env, msg.chat.id,
            reset.state === 'busy' || reset.state === 'pending'
              ? '⚠️ В этом тестовом режиме вложения пока не поддерживаются — это сообщение не добавил. Уже собранный ввод и текущую задачу не трогал; отправь запрос текстом.'
              : '⚠️ В этом тестовом режиме вложения пока не поддерживаются — задачу не запускал и эту порцию сбросил. Отправь её текстом; черновик можно сбросить кнопкой в меню.',
            {}, threadIdOf(msg)).catch(() => null);
          return json({ buffered: 0, refused: true, unsupported: 'media' });
        }
        if (reset.state === 'pending') {
          heldBehindPendingUnsupportedLaunch = !unsupportedMedia && oldUnsupported;
          if (heldBehindPendingUnsupportedLaunch) {
            // The original admission is still uncertain. Keep its evidence and
            // accept fresh text as held input; never make the user resend it or
            // risk a parallel launch. The normal busy path below stores it.
          } else {
          await sendTracked(this.env, msg.chat.id,
            '⌛ Предыдущая порция ещё сверяется с запуском, поэтому текст пока не добавил. Текущий запуск не тронут; отправь сообщение ещё раз после его завершения.',
            {}, threadIdOf(msg)).catch(() => null);
          return json({ buffered: 0, refused: true, reason: 'launch_pending' });
          }
        }
        if (reset.state !== 'pending') await sendTracked(this.env, msg.chat.id,
          reset.state === 'held-cleaned'
            ? '⚠️ Удалил неподдерживаемое вложение из отложенной порции; остальные сообщения и текущую задачу сохранил. Это текстовое сообщение добавил к отложенной порции.'
            : '⚠️ В предыдущей порции было вложение, которое этот режим не может передать. Сбросил старую порцию; это текстовое сообщение начал как новую задачу.',
          {}, threadIdOf(msg)).catch(() => null);
      }
      const buf = await this._exclusive(async () => {
        const items = (await this.state.storage.get('buf')) || [];
        if (this.env.EXECUTION_BACKEND === 'control-plane') {
          if (!Number.isSafeInteger(msg.message_id) || msg.message_id <= 0 ||
              (telegramUpdateId !== undefined && (!Number.isSafeInteger(telegramUpdateId) || telegramUpdateId < 0))) return null;
          const messageKey = `cp-input-message:${msg.message_id}`;
          const updateKey = telegramUpdateId === undefined ? null : `cp-input-update:${telegramUpdateId}`;
          if (await this.state.storage.get(messageKey) || (updateKey && await this.state.storage.get(updateKey))) return null;
          const batch = await this._batchIdLocked(msg.chat.id, threadIdOf(msg));
          await this.state.storage.transaction(async tx => {
            const scope = { chatId: msg.chat.id, threadId: threadIdOf(msg), profileId: controlPlaneClient(this.env).config.profileId };
            const existingScope = await tx.get('cpScope');
            if (existingScope && JSON.stringify(existingScope) !== JSON.stringify(scope)) throw new Error('Collector scope mismatch');
            await tx.put('cpScope', scope);
            const ownership = { batchId: batch.batchId, messageId: msg.message_id, telegramUpdateId: telegramUpdateId ?? null };
            await tx.put(messageKey, ownership);
            if (updateKey) await tx.put(updateKey, ownership);
            await tx.put('buf', [...items, { text, msg, telegramUpdateId }]);
            await this._bumpDraftRevisionLocked(tx);
          });
          items.push({ text, msg, telegramUpdateId });
          if (await this.state.storage.get('stopped')) await this._resumeAfterStopLocked(msg.message_id);
        }
        // Telegram can retry delivery of the same update.
        if (this.env.EXECUTION_BACKEND !== 'control-plane' && (!msg.message_id || !items.some(item => item.msg.message_id === msg.message_id))) {
          items.push({ text, msg });
          await this.state.storage.put('buf', items);
          if (await this.state.storage.get('stopped')) await this._resumeAfterStopLocked(msg.message_id);
        }
        // RC-06, same marker as /ingest: anything sitting in the buffer during a
        // run waits for an explicit choice afterwards, not for the quiet gate.
        if (await this.state.storage.get('busy')) {
          const marked = items.map(i => (i.heldWhileBusy ? i : { ...i, heldWhileBusy: true }));
          await this.state.storage.put('buf', marked);
          return marked;
        }
        return items;
      });
      if (buf === null) return json({ duplicate: true });

      const independentForceLaunch = flush && pendingStopWindow && cpMode && FORCE_RUN_RE.test(text || '');
      if (((await this.state.storage.get('busy')) === true && !independentForceLaunch)
          || heldBehindPendingUnsupportedLaunch || (pendingStopWindow && !independentForceLaunch)) {
        // A run or another launch barrier is still active. Hold new messages,
        // never auto-run them, and ACK them so the user isn't met with silence.
      if (pendingStopWindow) await this._showCollector(msg.chat?.id, buf.length, msg.message_id, threadIdOf(msg));
      else await this._showHeldNotice(msg.chat?.id, buf.length, msg.message_id, threadIdOf(msg));
        if (heldBehindPendingUnsupportedLaunch || pendingStopWindow) await sendTracked(this.env, msg.chat?.id,
          pendingStopWindow && !heldBehindPendingUnsupportedLaunch
            ? '🕒 Текст сохранил отдельно. Старая задача всё ещё сверяется. Кнопки в сообщении выше запустят этот ввод отдельной задачей.'
            : '🕒 Текст сохранил в отдельной отложенной порции. Предыдущая ещё сверяется с запуском; новую задачу не запускал. После сверки можно будет запустить этот текст.',
          {}, threadIdOf(msg)).catch(() => null);
        return json({ buffered: buf.length, held: true });
      }
      if (flush) {
        if (this.env.EXECUTION_BACKEND === 'control-plane') {
          if (!FORCE_RUN_RE.test(text || '')) return new Response('Explicit launch word required', { status: 400 });
          if (pendingStopWindow) {
            await this.state.storage.put('launchParallel', true);
            await this.state.storage.delete('stopped');
          }
          await this._dispatch();
          return json({ flushed: true });
        }
        // Force word (запускай/го) — launch immediately, coalescing everything.
        return this.fetch(new Request('https://intake/flush', { method: 'POST' }));
      }
      // Idle: arm the debounce timer and show the launch button with the live count.
      await this._armAutoDispatch(msg.chat?.id, buf, msg.message_id, threadIdOf(msg));
      return json({ buffered: buf.length });
    }

    if (url.pathname === '/flush' && request.method === 'POST') {
      // `parallel: true` — the user's explicit «⚡ Параллельно» (RC-03): launch
      // this batch NOW as a second run of the same busy window instead of
      // queueing it after the current one. Legacy callers send no body.
      const source = await request.json().catch(() => ({}));
      const stopWindowPending = this.env.EXECUTION_BACKEND === 'control-plane'
        && (await this.state.storage.get('cpStopWindow'))?.pending === true;
      const parallel = source.parallel === true || stopWindowPending;
      const styleLaunch = /^ws\|(explore|answer|auto)\|(\d+)$/.exec(source.callbackData || '');
      // An explicit ▶️ / force word is exactly the action that lifts a ⛔ hold (#1856).
      const authorized = await this._exclusive(async () => {
        if (this.env.EXECUTION_BACKEND === 'control-plane' && !(await this._callbackOwned(source))) return false;
        if (this.env.EXECUTION_BACKEND === 'control-plane') {
          const stopWindow = await this.state.storage.get('cpStopWindow');
          const unresolved = await this._activeUnresolvedLaunches();
          const belongsToPendingStop = parallel && stopWindow?.pending === true
            && Array.isArray(stopWindow.admissionLaunchKeys)
            && unresolved.every(key => stopWindow.admissionLaunchKeys.includes(key));
          if (this.cpDispatches || (unresolved.length && !belongsToPendingStop)) return false;
          if (stopWindow?.pending && !parallel) return false;
        }
        if (styleLaunch) {
          await this.state.storage.put('launchWorkStyle', styleLaunch[1]);
          await this.state.storage.put('launchWorkStyleSource', 'explicit');
        } else if (parallel) {
          await this.state.storage.put('launchWorkStyle', 'auto');
          await this.state.storage.put('launchWorkStyleSource', 'default');
        }
        if (parallel) await this.state.storage.put('launchParallel', true);
        await this.state.storage.delete('stopped');
        await this.state.storage.delete('resumedHeld');
        return this.env.EXECUTION_BACKEND === 'control-plane'
          ? { buffer: JSON.stringify((await this.state.storage.get('buf')) || []),
              retry: JSON.stringify(await this.state.storage.get('retryBatch')) }
          : true;
      });
      if (!authorized) return new Response('Callback ownership mismatch', { status: 409 });
      // Button tap / force word while a run is in flight. Never a second
      // concurrent run (#1527 F1), but never a silent no-op either: the held
      // «▶️ Запустить агента» button used to do nothing mid-run. First self-heal
      // a stale hold (lost push / restart — same poll the alarm uses); if the run
      // is really going, remember the tap and launch right after it ends.
      if ((await this.state.storage.get('busy')) === true) {
        const since = (await this.state.storage.get('busySince')) || 0;
        // Set the intent BEFORE the self-heal: if the hold turns out to be stale
        // (run already dead), the released window dispatches — still in parallel mode.
        if (parallel) await this.state.storage.put('launchParallel', true);
        // A tap on the separately-owned draft must not reconcile or release the
        // old stop window. Dispatch this explicit parallel batch in its own
        // session while preserving the old task's pending evidence.
        const stopWindowPending = this.env.EXECUTION_BACKEND === 'control-plane'
          && (await this.state.storage.get('cpStopWindow'))?.pending === true;
        if ((stopWindowPending && parallel) || !(await this._pollRunFinishedIfIdle(since, { launch: true }))) {
          // Only promise a queued launch when there IS held input to launch after
          // the run. A stale/duplicate tap on a run that already swallowed its own
          // batch has nothing to queue — arm nothing and stay silent (дыра №4):
          // replying «запущу эти сообщения» about messages that do not exist reads
          // as a failed launch (#293, owner 2026-09-28, chat -5501536471).
          const held = [...((await this.state.storage.get('retryBatch')) || []),
            ...((await this.state.storage.get('buf')) || [])];
          if (!held.length) {
            // Nothing to launch — drop the intent we just staged (a stale flag
            // would hijack the NEXT normal dispatch).
            if (parallel) await this.state.storage.delete('launchParallel');
            return json({ busy: true });
          }
          if (parallel) {
            // Attachments still landing: remember the intent (the tap is NOT
            // dropped) and start the moment the last one is ready — same UX as
            // the normal «📥 Задачу забрал» preparing flow, but in parallel mode.
            const pendingMedia = held.some(i => i.mediaPending
              || (i.preparingAt && Date.now() - i.preparingAt < 120000));
            if (pendingMedia) {
              await this.state.storage.put('launchWhenReady', true);
              return json({ busy: true, parallel: true, preparing: true });
            }
            // Take the batch right now — _dispatch joins the open window (its
            // ack appends this run's requestId; the hold drops after the LAST one).
            await this._dispatch();
            return json({ busy: true, parallel: true });
          }
          await this.state.storage.put('launchAfterRelease', true);
          // Turn ▶️ into its own undo right away (owner 29.09): a tap that leaves
          // the launch button sitting under the receipt reads as «не нажимается»,
          // and a vanished button reads as «пропала». queuedText + ↩️ is the whole
          // state in one screen; every later re-render (receipt/alarm) follows the
          // same launchQueued flag in _showCollector.
          await this.state.storage.put('launchQueued', true);
          const lastHeld = held[held.length - 1]?.msg;
          await this._showCollector(lastHeld?.chat?.id, held.length, lastHeld?.message_id, threadIdOf(lastHeld));
          return json({ busy: true, queued: true });
        }
        return json({ flushed: true, healed: true });
      }
      const buf = (await this.state.storage.get('retryBatch')) || (await this.state.storage.get('buf')) || [];
      if (!buf.length) return json({ empty: true });
      const pending = buf.some(i => i.mediaPending || (i.preparingAt && Date.now() - i.preparingAt < 120000));
      if (pending) {
        // The tap DID register — leaving it unanswered read as «кнопка не
        // нажимается». Confirm the request was taken, and remember it so the
        // batch launches by itself the moment the last attachment is ready.
        // `queued: true` means only "the tap is remembered, not dropped": NOTHING
        // is running yet (busy is false here), so the caller must NOT narrate it
        // as a running task — our own collector line below is the honest wording.
        if (parallel) await this.state.storage.put('launchParallel', true);
        await this.state.storage.put('launchWhenReady', true);
        // Same rule as the busy-queue tap: after «задачу забрал» the ▶️ is done —
        // the tail becomes ↩️ cancel, so this queued launch can also be taken back.
        await this.state.storage.put('launchQueued', true);
        await this._showCollector(buf[0].msg.chat.id, buf.length, buf.at(-1).msg.message_id, threadIdOf(buf[0].msg),
          '📥 Задачу забрал — часть сообщений ещё грузится. Сохраню всё и начну, как только получу вложения.');
        return json({ preparing: true, queued: true });
      }
      if (parallel) await this.state.storage.put('launchParallel', true);
      await this._dispatch(authorized === true ? undefined : authorized.buffer, authorized === true ? undefined : authorized.retry);
      return json(parallel ? { flushed: true, parallel: true } : { flushed: true });
    }

    // «↩️ Отменить передачу агенту» — undo of a TAPPED (remembered) launch.
    // Clears only the queue (launchAfterRelease/launchWhenReady/launchQueued);
    // a running task is never touched — stopping THAT is /tasks/stop's job.
    // The held messages stay exactly where they were: the next render simply
    // offers ▶️ again.
    if (url.pathname === '/cancel' && request.method === 'POST') {
      const source = await request.json().catch(() => ({}));
      const cancelled = await this._exclusive(async () => {
        if (this.env.EXECUTION_BACKEND === 'control-plane' && !(await this._callbackOwned(source))) return null;
        const store = this.state.storage;
        const had = !!((await store.get('launchQueued'))
          || (await store.get('launchAfterRelease'))
          || (await store.get('launchWhenReady'))
          || (!controlPlaneStopDisabled(this.env) && (await store.get('stopLaunch')))); // RC-04/05: отмена действует на ЛЮБОЙ пункт меню
        const stopLaunchCancelled = !controlPlaneStopDisabled(this.env) && !!(await store.get('stopLaunch'));
        await store.delete('launchQueued');
        await store.delete('launchAfterRelease');
        await store.delete('launchWhenReady');
        await store.delete('launchParallel');
        await store.delete('launchWorkStyle');
        await store.delete('launchWorkStyleSource');
        if (!controlPlaneStopDisabled(this.env)) await store.delete('stopLaunch');
        return { had, stopLaunchCancelled };
      });
      if (cancelled === null) return new Response('Callback ownership mismatch', { status: 409 });
      if (cancelled?.had) {
        // Re-render the same collector with ▶️ back — done outside the lock
        // (Telegram I/O), same single-owner serialization as every collector edit.
        const items = [...((await this.state.storage.get('retryBatch')) || []),
          ...((await this.state.storage.get('buf')) || [])];
        const last = items[items.length - 1]?.msg;
        if (last) {
          const busy = await this.state.storage.get('busy');
          await this._showCollector(last.chat?.id, items.length, last.message_id, threadIdOf(last),
            busy ? heldText(items.length) : null);
        }
      }
      return json({ cancelled: !!cancelled?.had, stopLaunchCancelled: !!cancelled?.stopLaunchCancelled });
    }

    // «🛑 Стоп и запуск с добавкой» / «⛔ Стоп → новая задача» (RC-04 / RC-05) —
    // the second half of those menu options. The gateway has ALREADY stopped the
    // run honestly (stopChat: intake hold → outbox/recovery cancel → kill) before
    // calling this; the DO only owns what happens to the held batch now.
    //
    // busy (the stop's run-finished push has not landed yet) → remember the choice
    // and let the release path run it: that is the one moment where the killed
    // run is provably gone AND the fresh dispatch gets the whole busy-window
    // bookkeeping (busy, requestId, alarm, «📨 Передаю…» collector). No window,
    // no intent left (a lost run-finished is released by the per-minute self-heal).
    // not busy (SS-08: the run had already finished) → degrade to an ordinary
    // launch, honestly narrated by the caller.
    if (url.pathname === '/stop-launch' && request.method === 'POST') {
      const source = await request.json().catch(() => ({}));
      const { mode = 'new', route = null } = source;
      const res = await this._exclusive(async () => {
        if (this.env.EXECUTION_BACKEND === 'control-plane' && !(await this._callbackOwned(source))) return null;
        if (this.env.EXECUTION_BACKEND === 'control-plane' && mode !== 'new' &&
            (this.cpDispatches || (await this._activeUnresolvedLaunches()).length)) return null;
        if (this.env.EXECUTION_BACKEND === 'control-plane' && (await this.state.storage.get('cpStopWindow'))?.pending && mode !== 'new') return null;
        const store = this.state.storage;
        if (await store.get('stopLaunch')) return { already: true };
        const items = [...((await store.get('retryBatch')) || []), ...((await store.get('buf')) || [])];
        if (!items.length) return { nothing: true };
        if (await store.get('busy') && !(mode === 'new' && this.env.EXECUTION_BACKEND === 'control-plane'
            && (await store.get('cpStopWindow'))?.pending)) {
          await store.put('stopLaunch', { mode: mode === 'supp' ? 'supp' : 'new', route, at: Date.now() });
          return { waiting: true, count: items.length };
        }
        await this._prepareStopLaunchLocked({ mode: mode === 'supp' ? 'supp' : 'new', route }, items);
        if (this.env.EXECUTION_BACKEND === 'control-plane' && mode === 'new'
            && ((await store.get('cpStopWindow'))?.pending || await store.get('busy'))) await store.put('launchParallel', true);
        return { launching: true, count: items.length };
      });
      if (res === null) return new Response('Callback ownership mismatch', { status: 409 });
      if (res.launching) await this._dispatch();
      return json(res);
    }

    return new Response('not found', { status: 404 });
  }

  // Move the held batch into the launch position and drop every OTHER launch
  // intent, so exactly one run can come out of a stop-and-launch choice (K7:
  // «ровно один ран — без дубля из буфера, retry или GTD»). Must run inside
  // _exclusive; `spec` is re-read under the lock by _consumeStopLaunch.
  async _prepareStopLaunchLocked(spec, items) {
    if (controlPlaneStopDisabled(this.env)) throw controlPlaneStopDisabledError();
    const store = this.state.storage;
    await store.delete('stopped'); // the explicit choice IS the lift of the ⛔ hold
    for (const k of ['launchAfterRelease', 'launchWhenReady', 'launchQueued', 'launchParallel', 'launchWorkStyle', 'launchWorkStyleSource',
      'debounceExpiresAt', 'gateLevel', 'gateConsulted', 'gateErrAttempts', 'receiptDue']) {
      await store.delete(k);
    }
    const batch = spec.mode === 'supp' ? [this._supplementHeaderItem(items.at(-1), spec.route), ...items] : items;
    await store.put('retryBatch', batch);
    await store.delete('buf');
    return batch;
  }

  // RC-04/RC-05 — run the batch the user chose. Called from the release path, the
  // alarm and the media-completion path; whoever gets there first runs it once
  // (the flag is taken under the lock). Still-preparing attachments are NOT lost:
  // the choice stays remembered and the next tick tries again.
  async _consumeStopLaunch() {
    if (controlPlaneStopDisabled(this.env)) return false;
    const spec = await this.state.storage.get('stopLaunch');
    if (!spec) return false;
    if (this.env.EXECUTION_BACKEND === 'control-plane' && (await this.state.storage.get('cpStopWindow'))?.pending && spec.mode !== 'new') return false;
    // The window still belongs to the run being stopped: launching NOW would lose
    // the bookkeeping (_dispatch refuses a non-empty busy window) and, worse, take
    // the batch out of the launch position while nobody may launch it. Wait for
    // the release — run-finished, the self-heal poll or BUSY_MAX — which always
    // ends in _afterBusyRelease and comes back here.
    if (await this.state.storage.get('busy') && !(this.env.EXECUTION_BACKEND === 'control-plane'
        && spec.mode === 'new' && (await this.state.storage.get('cpStopWindow'))?.pending)) return false;
    const items = [...((await this.state.storage.get('retryBatch')) || []),
      ...((await this.state.storage.get('buf')) || [])];
    if (!items.length) {
      await this._exclusive(async () => {
        if (!(await this.state.storage.get('stopLaunch'))) return;
        await this.state.storage.delete('stopLaunch');
        await this.state.storage.delete('stopped');
      });
      return false;
    }
    if (items.some(i => i.mediaPending || (i.preparingAt && Date.now() - i.preparingAt < 120000))) {
      await this.state.storage.setAlarm(Date.now() + 60_000); // вложения ещё едут
      return false;
    }
    const taken = await this._exclusive(async () => {
      const current = await this.state.storage.get('stopLaunch');
      if (!current) return false;
      await this.state.storage.delete('stopLaunch');
      await this._prepareStopLaunchLocked(current, items);
      if (this.env.EXECUTION_BACKEND === 'control-plane' && current.mode === 'new'
          && ((await this.state.storage.get('cpStopWindow'))?.pending || await this.state.storage.get('busy'))) await this.state.storage.put('launchParallel', true);
      return true;
    });
    if (!taken) return false;
    await this._dispatch();
    return true;
  }

  // The RC-04 marker rides as a normal buffer item so the whole path (assemble,
  // snapshot, run) stays the ordinary one — it only sorts first and pins the
  // session the stopped task was running in.
  _supplementHeaderItem(base, route) {
    return { text: SUPPLEMENT_HEADER, msg: { ...(base?.msg || {}), chat: base?.msg?.chat, text: SUPPLEMENT_HEADER, intakeRoute: route } };
  }

  // Every routed message passes here first: while «➕ Дополнить» is armed it joins
  // the supplement draft instead of `buf` (caller shows the confirmation from the
  // `supplement` reply). An expired draft is replayed into the ordinary flow first,
  // in order, so the user's words are never lost; then this message routes normally.
  async _divertToSupplement(msg, path) {
    if (!msg) return null;
    const res = await this._supplement({ op: 'add', msg });
    if (res.armed) return json({ supplement: { taskId: res.taskId, count: res.count, confirmMsgId: res.confirmMsgId } });
    for (const item of res.released) {
      await this.fetch(new Request(`https://intake${path}`, { method: 'POST',
        body: JSON.stringify({ text: item.msg.text, msg: item.msg, flush: false }) }));
    }
    return null;
  }

  // ops: arm {taskId, sessionId, expiresAt} → {released} (items of a replaced draft);
  //      add {msg, now} → {armed, count, confirmMsgId} | {armed:false, released} on expiry;
  //      confirm {msgId} → {count}; take → {draft}; peek → {draft}.
  async _supplement({ op, ...a }) {
    const draft = (await this.state.storage.get('supplement')) || null;
    if (op === 'arm') {
      await this.state.storage.put('supplement', { taskId: a.taskId, sessionId: a.sessionId,
        expiresAt: a.expiresAt, items: [], confirmMsgId: null });
      return { released: draft?.items || [] };
    }
    if (op === 'add') {
      if (!draft) return { armed: false, released: [] };
      if ((a.now ?? Date.now()) >= draft.expiresAt) {
        await this.state.storage.delete('supplement');
        return { armed: false, released: draft.items };
      }
      // Telegram redelivers updates on a slow webhook — one message, one item.
      if (!draft.items.some(i => i.msg.message_id === a.msg.message_id)) {
        draft.items.push({ text: a.msg.text, msg: a.msg });
        await this.state.storage.put('supplement', draft);
      }
      return { armed: true, taskId: draft.taskId, count: draft.items.length, confirmMsgId: draft.confirmMsgId };
    }
    if (op === 'confirm') {
      if (!draft) return { count: 0 };
      await this.state.storage.put('supplement', { ...draft, confirmMsgId: a.msgId });
      return { count: draft.items.length };
    }
    if (op === 'take') {
      if (draft) await this.state.storage.delete('supplement');
      return { draft };
    }
    return { draft };
  }

  async _ingestMedia(msg, session) {
    const id = await mediaId(msg);
    const accepted = await this._exclusive(async () => {
      const seen = (await this.state.storage.get('received')) || [];
      const items = (await this.state.storage.get('buf')) || [];
      if (seen.includes(msg.message_id) || items.some(i => i.msg.message_id === msg.message_id)) return false;
      // Reservation and watchdog survive a crash before enqueue's network call.
      await this.state.storage.transaction(async tx => {
        items.push({ text: msg.text, msg: { ...msg, mediaJob: id }, mediaPending: true, mediaOwner: session.username, mediaFirstSeenAt: Date.now(),
          ...(await tx.get('busy') ? { heldWhileBusy: true } : {}) });
        await tx.put('buf', items);
        await this._bumpDraftRevisionLocked(tx);
        await tx.put('received', [...seen, msg.message_id].slice(-1000));
        await tx.setAlarm(Date.now() + 60000);
      });
      // Media buffered: cancel any pending debounce so the auto-dispatch timer
      // doesn't fire while we're still waiting for the transcript.
      await this.state.storage.delete('debounceExpiresAt');
      await this.state.storage.delete('gateLevel');
      // A new attachment after ⛔ Стоп is a new user action (#1856).
      if (await this.state.storage.get('stopped')) await this._resumeAfterStopLocked(msg.message_id);
      return true;
    });
    if (!accepted) return json({ duplicate: true });
    await enqueueMedia(msg, this.env, session).catch(() => {}); // watchdog retries
    await this._scheduleReceipt();
    // Медиа в пакете — тоже наблюдаемый вход (arch#132 R9): снаружи видно, что
    // шлюз ждёт расшифровку, и это НЕ то же самое, что «ввод потерялся».
    const batch = await this._exclusive(async () => this._batchIdLocked(msg.chat.id, threadIdOf(msg)));
    await this._announcePending(this.env, batch, {
      profileId: session?.username ?? null,
      destinationId: String(msg.chat.id),
      prepState: 'preparing',
      deadlineMs: PENDING_BATCH_DEADLINE_MS,
    });
    return json({ queued: true, id });
  }

  async _recoverMedia() {
    const pending = ((await this.state.storage.get('buf')) || []).filter(i => i.mediaPending);
    if (!pending.length) return;
    await this.state.storage.setAlarm(Date.now() + 60000);
    for (const item of pending) {
      try {
        await enqueueMedia(item.msg, this.env, { username: item.mediaOwner }, true);
      } catch {
        let failed = false;
        await this._exclusive(async () => {
          const items = (await this.state.storage.get('buf')) || [];
          const current = items.find(i => i.msg.mediaJob === item.msg.mediaJob && i.mediaPending);
          if (!current) return;
          current.enqueueFailures = (current.enqueueFailures || 0) + 1;
          failed = current.enqueueFailures >= 3;
          await this.state.storage.put('buf', items);
        });
        if (failed) await this._mediaResult({ id: item.msg.mediaJob, messageId: item.msg.message_id,
          username: item.mediaOwner, error: 'Очередь обработки временно недоступна' });
      }
      // Watchdog: a media job whose DO lost its alarm (eviction between the
      // enqueue and the alarm write) never calls back, so the item would sit
      // `mediaPending` forever — the chat shows no transcription, no launch
      // button, and a tap answers «ещё грузится» indefinitely. After
      // MEDIA_DEADLINE_MS give up: keep the original Telegram reference for
      // recovery, drop the item from the launchable batch, and tell the user.
      const age = Date.now() - (item.mediaFirstSeenAt || Date.now());
      if (age >= MEDIA_DEADLINE_MS) {
        await this._mediaResult({ id: item.msg.mediaJob, messageId: item.msg.message_id,
          username: item.mediaOwner, error: 'Не удалось получить вложение' });
      }
    }
  }

  async _mediaResult(result) {
    let notify = null;
    const response = await this._exclusive(async () => {
      const items = (await this.state.storage.get('buf')) || [];
      const index = items.findIndex(i => i.msg.mediaJob === result.id && i.msg.message_id === result.messageId);
      // Already committed: delivery retry must not overwrite/recreate an item.
      if (index < 0) {
        const delivered = await this.state.storage.get(`media-delivered:${result.id}`);
        return delivered ? json({ duplicate: true }) : new Response('Reservation cleared', { status: 410 });
      }
      const item = items[index];
      if (item.mediaOwner !== result.username) return new Response('Owner mismatch', { status: 403 });
      if (!item.mediaPending) return json({ duplicate: true });
      if (!result.error && (!result.fileRef || result.fileRef.id !== result.id || result.fileRef.storage !== 'r2')) {
        return new Response('Invalid result', { status: 400 });
      }
      await this.state.storage.transaction(async tx => {
        if (result.error) {
          // Keep failed media outside the launchable batch so new text can proceed.
          // Original Telegram metadata and any completed R2 stages stay durable.
          await tx.put(`media-failed:${result.id}`, { ...item, error: result.error });
          items.splice(index, 1);
        } else {
          items[index] = { ...item, mediaPending: false, msg: { ...item.msg,
            fileRef: result.fileRef, transcript: result.transcript, transcriptRef: result.transcriptRef } };
        }
        await tx.put('buf', items);
        await this._bumpDraftRevisionLocked(tx);
        await tx.put(`media-delivered:${result.id}`, true);
        if (!items.some(i => i.mediaPending) && !(await tx.get('busy'))) await tx.deleteAlarm();
      });
      notify = { chatId: item.msg.chat.id, threadId: threadIdOf(item.msg), messageId: item.msg.message_id };
      return json({ accepted: true });
    });
    if (notify) {
      const text = result.error
        ? `⚠️ Не удалось принять файл (${result.error}). Задача не запускалась; отправь файл ещё раз.`
        : result.transcript ? `🎤 ${result.transcript}` : '✅ Вложение сохранено. Можно запускать проработку.';
      if (!result.error) {
        await this._scheduleReceipt();
      } else if (result.transcript?.length >= 800) {
        await sendDocument(this.env.BOT_TOKEN, notify.chatId, `transcript-${notify.messageId}.txt`, result.transcript, '🎤 Расшифровка голосового', notify.threadId).catch(() => {});
      } else {
        await sendTracked(this.env, notify.chatId, text, { ...anchor(notify.messageId), parse_mode: undefined }, notify.threadId).catch(() => {});
      }
      // After the transcript arrives, arm auto-dispatch the same way a plain text
      // message would (fresh launch button + gate). Before this fix a buffer whose
      // newest item was media never got auto-dispatch armed at all — _ingestMedia
      // deletes any pending debounce and nothing here re-armed it, so a batch that
      // ended in a photo/voice message could ONLY ever be launched by hand, even
      // once the transcript made its content fully readable (the "звонил чётко,
      // ничего не запустилось" bug, 2026-09-22).
      if (!result.error) {
        const remaining = (await this.state.storage.get('buf')) || [];
        const busy = await this.state.storage.get('busy');
        const ready = !busy && remaining.length && !remaining.some(i => i.mediaPending);
        // RC-04/RC-05: the attachment the chosen launch was waiting for just
        // landed and the run it continues is already gone — run the choice now.
        // Checked BEFORE the ⛔ hold: the hold is set by the stop that made this
        // choice, and it must not block the launch it authorised.
        if (ready && await this.state.storage.get('stopLaunch')) {
          await this._consumeStopLaunch();
          return;
        }
        // ⛔ Стоп held the batch: the transcript only refreshes the stopped
        // collector (receipt above) — no timer, no remembered launch (#1856).
        const stopped = await this.state.storage.get('stopped');
        if (ready && !stopped) {
          // The user tapped «▶️ Запустить» while the attachment was still
          // downloading — the tap was honoured then («задачу забрал»), so start
          // now instead of making them find the button again.
          if (await this.state.storage.get('launchWhenReady')) {
            await this.state.storage.delete('launchWhenReady');
            await this._dispatch();
          } else {
            await this._armAutoDispatch(notify.chatId, remaining, notify.messageId, notify.threadId);
          }
        }
      }
      // H3: media-error path above can drop the alarm with items still buffered.
      await this._ensureArmed(notify.chatId);
    }
    return response;
  }

  // Must be called inside _exclusive. A NEW message after ⛔ Стоп lifts the hold
  // (#1856): the normal collector/judge flow resumes for the whole buffer, and the
  // collector names how many of those messages were held by the stop, so they
  // never ride along unseen.
  async _resumeAfterStopLocked(newMessageId = null) {
    if (this.env.EXECUTION_BACKEND === 'control-plane' && (await this.state.storage.get('cpStopWindow'))?.pending) return;
    const items = [...((await this.state.storage.get('retryBatch')) || []), ...((await this.state.storage.get('buf')) || [])];
    const held = items.filter(i => i.msg?.message_id !== newMessageId).length;
    await this.state.storage.delete('stopped');
    if (held) await this.state.storage.put('resumedHeld', held);
    else await this.state.storage.delete('resumedHeld');
  }

  // Idle + non-busy: (re)arm the debounce timer and show the launch button with
  // the live count. One place for every caller (plain text, legacy /append, and
  // a media item whose transcript just resolved) so the auto-dispatch gate is
  // never silently skipped for one of them.
  async _armAutoDispatch(chatId, remaining, replyToMessageId, threadId = null) {
    if (await this._autoLaunchBlocked(remaining)) {
      await this._scheduleReceipt();
      return;
    }
    await this.state.storage.delete('gateLevel');
    await this.state.storage.delete('shortDebounce');
    await this.state.storage.delete('gateConsulted');
    // New input invalidates the previous judge-failure budget (#248): the retry
    // count belongs to one batch, not to the chat forever.
    await this.state.storage.delete('gateErrAttempts');
    // …and any parked state: a new message means the user answered the ask.
    await this.state.storage.delete('parkedAt');
    await this.state.storage.delete('parkReoffers');
    await this.state.storage.put('autoPolicy', 'quiet-3m-v1');
    const debounceMs = DEBOUNCE_MS;
    const expiresAt = Date.now() + debounceMs;
    await this.state.storage.put('debounceExpiresAt', expiresAt);
    await this.state.storage.setAlarm(expiresAt);
    await this._scheduleReceipt();
  }

  // ИНВАРИАНТ: непустой буфер, который никто не держит (не busy, не ⛔ hold),
  // всегда имеет живой аларм.
  //
  // Все нормальные ветки взводят свой таймер (дебаунс / park re-offer / media
  // watchdog / busy poll). Остаются три, где аларм уже съеден, а буфер — нет:
  //   H1 резервация судьи проиграла гонку (`!current` в alarm) — уходим без таймера;
  //   H2 бюджет повторов судьи исчерпан — остаётся только кнопка коллектора;
  //   H3 `_mediaResult` с ошибкой медиа снимает аларм в транзакции, а items
  //      (текст) в буфере остаются.
  // Именно этот класс дал инцидент 2026-10-04 (чат -5496844108): голосовое
  // принято и расшифровано, автозапуск не взведён, кнопки нет — 6 мин 42 с тишины,
  // ответ только после ручного тапа по старой кнопке. Агент при этом был здоров.
  //
  // Это НЕ перезапуск судьи: ожидание нового контекста (_armAutoDispatch на новом
  // вводе) и проверка зависания (этот инвариант) — разные механизмы. На неизменном
  // вводе LLM не зовётся.
  async _ensureArmed(chatId) {
    const store = this.state.storage;
    const items = [...((await store.get('retryBatch')) || []), ...((await store.get('buf')) || [])];
    if (!items.length) return;
    if (await store.get('busy')) return;      // busy-poll держит свой таймер
    if (await store.get('stopped')) return;   // ⛔ hold: запускать нельзя by design
    if ((await store.getAlarm()) !== null) return; // таймер уже есть
    await store.setAlarm(Date.now() + ARM_WATCHDOG_MS);
  }

  // Chat session for the judge — a missing/odd KV in tests must never break the gate.
  async _gateSession(chatId, threadId) {
    try { return await getSession(this.env.SESSIONS, chatId, threadId); } catch { return null; }
  }

  // RC-06 (Ф3): two states where NOTHING may launch itself.
  //   • a «стоп + запуск» choice is waiting for its confirmed start;
  //   • the whole buffer is input that arrived DURING a run (heldWhileBusy) and
  //     the user has chosen nothing yet — once the run ends the collector shows
  //     the menu and the batch waits (US-BUF-04's quiet auto-start stays for
  //     idle input, and a NEW message after the release re-arms it, exactly as
  //     stoppedText promises: «новое сообщение вернёт обычный режим»).
  async _autoLaunchBlocked(buf) {
    if (await this.state.storage.get('stopLaunch')) return true;
    const items = buf || (await this.state.storage.get('buf')) || [];
    return items.length > 0 && items.every(i => i.heldWhileBusy);
  }

  // Owner 2026-09-29: the delay and the reason must be spoken, and a short
  // «продолжай» may only fast-launch when the judge can see the previous agent
  // answer. The agent gate is the single source of that verdict; this asks it
  // ONCE per input (after the receipt settles) and applies the returned delay +
  // announcement. Any miss keeps the default three-minute timer, so the expiry
  // gate below still decides — never a silent dead-end.
  async _consultGate(chatId, threadId = null) {
    if (this.env.EXECUTION_BACKEND === 'control-plane') return;
    if (!chatId || !this.env.AGENT_URL) return;
    const store = this.state.storage;
    const debounceExpiresAt = await store.get('debounceExpiresAt');
    if (!debounceExpiresAt) return;
    const buf = (await store.get('buf')) || [];
    if (!buf.length || buf.some(i => i.mediaPending || i.preparingAt)) return;
    if (await this._autoLaunchBlocked(buf)) return; // RC-06 — nothing starts itself
    const snapshot = JSON.stringify(buf);
    if ((await store.get('gateConsulted')) === snapshot) return; // once per input
    const intent = coalescedIntent(buf);
    if (!intent.trim()) return;
    const session = await this._gateSession(chatId, threadId);
    let verdict;
    try {
      verdict = await checkCompleteness(this.env, { text: intent, username: session?.username || null, chatId, threadId });
    } catch { return; } // keep the default timer; the expiry gate re-checks
    // Judge unavailable: not a verdict — keep the default timer (the expiry branch
    // owns the bounded retry) instead of recording an `error` as «checked».
    if (verdict?.level === 'error') return;
    const applied = await this._exclusive(async () => {
      if (JSON.stringify((await store.get('buf')) || []) !== snapshot) return false;
      if (await store.get('busy')) return false;
      if (await store.get('stopped')) return false;
      if (await store.get('debounceExpiresAt') !== debounceExpiresAt) return false;
      const delay = Number.isFinite(verdict?.delayMs) && verdict.delayMs > 0 ? verdict.delayMs : DEBOUNCE_MS;
      const expiresAt = Date.now() + delay;
      await store.put('gateConsulted', snapshot);
      await store.put('gateLevel', verdict?.level || null);
      await store.put('debounceExpiresAt', expiresAt);
      await store.setAlarm(expiresAt);
      return true;
    });
    if (applied && verdict?.announce) {
      await this._showCollector(chatId, buf.length, buf.at(-1)?.msg?.message_id, threadId, verdict.announce);
    }
  }

  async _readSnapshot(id) {
    const meta = await this.state.storage.get(`input:${id}`);
    if (!meta) return null;
    let data = '';
    for (let i = 0; i < meta.chunks; i++) data += await this.state.storage.get(`input:${id}:${i}`);
    return JSON.parse(data);
  }

  async _scheduleReceipt() {
    const due = Date.now() + RECEIPT_MS;
    await this.state.storage.put('receiptDue', due);
    const alarm = await this.state.storage.getAlarm();
    if (!alarm || alarm > due) await this.state.storage.setAlarm(due);
  }

  async _showHeldNotice() { await this._scheduleReceipt(); }

  // Serialize Telegram edits independently of buffer mutations. A slow send cannot
  // create two collectors, and each edit reads the latest durable count.
  // `fresh: true` skips the edit path and POSTS a new bubble. Every other caller
  // keeps editing the one collector: for count updates an edit is the right call
  // (no chat noise), but for a verdict the user must SEE it — see _offerManualLaunch.
  async _showCollector(chatId, count, replyToMessageId, threadId = null, override = null, { fresh = false } = {}) {
    const previous = this.uiMutation;
    let release;
    this.uiMutation = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      if (!chatId) return null;
      const items = [...((await this.state.storage.get('retryBatch')) || []), ...((await this.state.storage.get('buf')) || [])];
      if (!override && !items.length) return null;
      const cpMode = this.env.EXECUTION_BACKEND === 'control-plane';
      const draftRevision = cpMode ? await this._exclusive(async () => {
        let revision = await this.state.storage.get('draftRevision');
        if (!Number.isSafeInteger(revision) || revision < 1) {
          revision = 1;
          await this.state.storage.put('draftRevision', revision);
        }
        return revision;
      }) : null;
      const queued = !!(await this.state.storage.get('launchQueued'));
      const stopped = !!(await this.state.storage.get('stopped'));
      const stopPending = this.env.EXECUTION_BACKEND === 'control-plane' && (await this.state.storage.get('cpStopWindow'))?.pending === true;
      const busy = !!(await this.state.storage.get('busy'));
      const canLaunchIndependently = cpMode && stopPending && items.length > 0;
      const stopLaunch = await this.state.storage.get('stopLaunch');
      const resumedHeld = (await this.state.storage.get('resumedHeld')) || 0;
      const n = items.length || count;
      const text = stopPending && items.length
        ? `⏳ Старая задача ещё сверяется. Этот независимый ввод можно запустить отдельно.`
        : (stopLaunch && !TOOK_IT.test(override || '')) ? stopLaunchText(n, stopLaunch.mode)
        : override || (queued ? queuedText(n)
        : stopped ? stoppedText(n)
        : (cpMode ? `✓ Получил ${n} сообщений. Всё собрано в один input. Выбери, как начать.` : collectorText(n)) + (resumedHeld ? resumedNote(Math.min(resumedHeld, n)) : ''));
      // Priority: a queued tap owns the screen (↩️ undo) — even under the 📥 status,
      // so «задачу забрал» can be walked back. Otherwise launch button under every
      // status that is not "the batch is taken" (issue #303).
      // TOOK_IT (📨 dispatching / 📥 queued — the 📥 bubble can appear before any
      // release) describes input that has already left for the agent.
      // busy deliberately does NOT mask ▶️ — held input is a batch of its own, and
      // killing the button here left the chat with no way to launch it (issue #303).
      let unknownDismiss = null;
      if (cpMode && stopPending) {
        const window = await this.state.storage.get('cpStopWindow');
        const unresolved = (await this.state.storage.get('cpUnresolvedLaunches')) || [];
        const launchKey = unresolved.find(key => (window?.admissionLaunchKeys || []).includes(key));
        const checkpoint = launchKey && await this.state.storage.get(`cp-launch:${launchKey}`);
        if (launchKey && checkpoint && !checkpoint.userDismissed && !window?.userDismissedLaunchKeys?.includes(launchKey)) {
          const token = crypto.randomUUID();
          unknownDismiss = { token, launchKey, intentId: window.intentId, username: window.username };
          await this.state.storage.put(`cp-unknown-dismiss:${token}`, { ...unknownDismiss, messageId: null });
        }
      }
      // A pending stop belongs to the old run. Its stale queue/stop action must
      // not hide controls for this distinct, still-unlaunched draft.
      const keyboard = (queued || stopLaunch) && !canLaunchIndependently ? CANCEL_BTN
        : TOOK_IT.test(override || '') ? STATUS_BTN
        : (busy && !canLaunchIndependently) ? (cpMode ? workStyleKeyboard(draftRevision, { busy: true, stopEnabled: this.env.TG_SLICE_STOP_ENABLED !== 'false' }) : QUEUE_BTN)
        : cpMode
          ? workStyleKeyboard(draftRevision)
        : LAUNCH_BTN;
      if (unknownDismiss) keyboard.push([{ text: '⏸ Не ждать старую задачу', callback_data: `intake_dismiss_unknown|${unknownDismiss.token}` }]);
      let prevId = await this.state.storage.get('collectorMsgId');
      const batch = cpMode ? await this._exclusive(async () => this._batchIdLocked(chatId, threadId)) : null;
      const baseClaimKey = batch ? `cp-collector-send:${batch.batchId}` : null;
      // A lost/failed send ACK must not wedge a pending-stop draft forever.
      // New input bumps draftRevision, so it gets one new safe collector attempt;
      // callbacks from any older bubble remain revision-bound and are rejected.
      const claimKey = baseClaimKey && stopPending && items.length
        ? `${baseClaimKey}:r${draftRevision}` : baseClaimKey;
      if (claimKey && !prevId) {
        const claim = await this.state.storage.get(claimKey);
        if (!claim && claimKey !== baseClaimKey) {
          const previousSent = await this.state.storage.get(baseClaimKey);
          if (previousSent?.state === 'sent' && previousSent.messageId) {
            prevId = previousSent.messageId;
            await this.state.storage.put('collectorMsgId', prevId);
          }
        }
        if (claim?.state === 'sent' && claim.messageId) {
          prevId = claim.messageId;
          await this.state.storage.put('collectorMsgId', prevId);
        }
        if (claim?.state === 'sending' || claim?.state === 'unknown') {
          if (claim.state === 'sending') await this.state.storage.put(claimKey, { ...claim, state: 'unknown' });
          return null;
        }
      }
      const previousCollectorBatch = cpMode ? await this.state.storage.get('collectorBatchId') : null;
      if (stopPending && items.length && previousCollectorBatch !== batch?.batchId) prevId = null;
      if (prevId && (!fresh || cpMode)) {
        const edited = await editMessage(this.env.BOT_TOKEN, chatId, prevId, text,
          { reply_markup: { inline_keyboard: keyboard } }).catch(() => null);
        if (edited?.ok || /message is not modified/i.test(edited?.description || '')) {
          if (unknownDismiss) await this.state.storage.put(`cp-unknown-dismiss:${unknownDismiss.token}`, { ...unknownDismiss, messageId: prevId });
          if (cpMode && batch?.batchId) await this.state.storage.put('collectorBatchId', batch.batchId);
          return prevId;
        }
        // During unresolved stop, the user needs a visible launch control for the
        // independent draft. If Telegram cannot edit the prior collector, publish
        // a fresh one (the old bubble is neutralized below when the send succeeds).
        if (!canLaunchIndependently && !/message to edit not found/i.test(edited?.description || '')) {
          await this._scheduleReceipt();
          return prevId;
        }
      }
      if (claimKey) await this.state.storage.put(claimKey, { state: 'sending' });
      const sent = await sendKeyboardTracked(this.env, chatId, text, keyboard, anchor(replyToMessageId), threadId).catch(() => null);
      const id = sent?.result?.message_id;
      if (claimKey) await this.state.storage.put(claimKey, id && sent?.ok
        ? { state: 'sent', messageId: id } : { state: 'unknown' });
      // A fresh bubble becomes THE collector: the older one is edited to a neutral
      // line so two launch buttons never compete (same reason as /stop).
      if (id && (fresh || stopPending && items.length)) {
        await editMessage(this.env.BOT_TOKEN, chatId, prevId, '↑ Сообщение выше устарело — новое ниже.',
          { reply_markup: { inline_keyboard: [] } }).catch(() => null);
        await this.state.storage.put('collectorMsgId', id);
        if (unknownDismiss) await this.state.storage.put(`cp-unknown-dismiss:${unknownDismiss.token}`, { ...unknownDismiss, messageId: id });
        if (batch?.batchId) await this.state.storage.put('collectorBatchId', batch.batchId);
      } else if (id) {
        await this.state.storage.put('collectorMsgId', id);
        if (unknownDismiss) await this.state.storage.put(`cp-unknown-dismiss:${unknownDismiss.token}`, { ...unknownDismiss, messageId: id });
        if (cpMode && batch?.batchId) await this.state.storage.put('collectorBatchId', batch.batchId);
      }
      else if (!cpMode) await this._scheduleReceipt();
      return id || null;
    } finally { release(); }
  }

  // Parked = the judge said «insufficient» (or its retry budget ran out). The batch
  // stays, the user is asked ONCE in a fresh bubble, and one re-offer timer keeps
  // the chat from going silent forever. Auto-launch stays off by design (#200).
  async _parkBatch(chatId, buf, threadId, text) {
    const last = buf.at(-1).msg;
    await this._showCollector(chatId, buf.length, last.message_id, threadId, text, { fresh: true });
    await this.state.storage.put('parkedAt', Date.now());
    await this.state.storage.put('parkReoffers', 0);
    await this.state.storage.setAlarm(Date.now() + PARK_REOFFER_MS);
  }

  // Coalesce the buffer into one message and run it. Marks the chat busy so
  // anything sent during the run is held (surfaced with a fresh button afterwards).
  async _dispatch(expectedBuffer, expectedRetryBatch) {
    const parallel = !!(await this.state.storage.get('launchParallel'));
    let launchWorkStyle = 'auto';
    let launchWorkStyleSource = 'default';
    const buf = await this._exclusive(async () => {
      if (this.env.EXECUTION_BACKEND === 'control-plane' && (await this.state.storage.get('cpStopWindow'))?.pending && !parallel) return [];
      // A parallel dispatch (RC-03) is allowed to start while the window is
      // open — it JOINS it; every other dispatch still waits for the release.
      if ((await this.state.storage.get('busy')) && !parallel) return [];
      // ⛔ Стоп holds the batch: only /flush (which lifts the hold first) may launch.
      if (await this.state.storage.get('stopped')) return [];
      if (expectedBuffer !== undefined && JSON.stringify((await this.state.storage.get('buf')) || []) !== expectedBuffer) return [];
      if (expectedRetryBatch !== undefined && JSON.stringify(await this.state.storage.get('retryBatch')) !== expectedRetryBatch) return [];
      // Cancel any pending debounce alarm — dispatch is happening now (manually or
      // via the timer itself). Without this the alarm could fire a second dispatch.
      await this.state.storage.delete('debounceExpiresAt');
      await this.state.storage.delete('gateLevel');
      await this.state.storage.delete('parkedAt');
      await this.state.storage.delete('parkReoffers');
      const retryBatch = await this.state.storage.get('retryBatch');
      const items = retryBatch || (await this.state.storage.get('buf')) || [];
      if (!items.length) return [];
      if (items.some(i => i.mediaPending || (i.preparingAt && Date.now() - i.preparingAt < 120000))) return [];
      items.sort((a, b) => (a.msg.message_id || 0) - (b.msg.message_id || 0));
      const selectedStyle = await this.state.storage.get('launchWorkStyle');
      launchWorkStyle = WORK_STYLES.includes(selectedStyle) ? selectedStyle : 'auto';
      launchWorkStyleSource = await this.state.storage.get('launchWorkStyleSource') === 'explicit' ? 'explicit' : 'default';
      if (this.env.EXECUTION_BACKEND === 'control-plane') {
        const unresolved = (await this.state.storage.get('cpUnresolvedLaunches')) || [];
        const launchKey = JSON.stringify(items.map(item => item.msg?.message_id));
        const client = controlPlaneClient(this.env);
        const base = items.at(-1).msg;
        const continuation = items.find(item => item.msg.intakeRoute)?.msg;
        await this.state.storage.put(`cp-launch:${launchKey}`, {
          msg: { ...base, text: coalesceBuffer(items), intakeItems: items, intakeRoute: continuation?.intakeRoute },
          initialMsgId: null, parallel, workStyle: launchWorkStyle, workStyleSource: launchWorkStyleSource,
          profileId: client.config.profileId, botUsername: client.config.botUsername,
        });
        await this.state.storage.put('cpUnresolvedLaunches', [...new Set([...unresolved, launchKey])]);
        this.cpDispatches++;
      }
      // The FIRST run of a window owns busy/since; a parallel dispatch joins an
      // already open window without resetting its age (BUSY_MAX counts from A).
      const windowOwned = !(await this.state.storage.get('busy'));
      if (windowOwned) {
        await this.state.storage.put('busy', true);
        await this.state.storage.put('busySince', Date.now());
        await this.state.storage.setAlarm(Date.now() + BUSY_POLL_MS);
      }
      await this.state.storage.put('launching', items);
      if (!retryBatch) await this.state.storage.delete('buf');
      await this.state.storage.delete('retryBatch');
      // Point of no return: the batch is leaving — the ↩️ tail must not outlive it
      // (the «📨 Передаю» status below is STATUS_BTN, and a stale flag would put
      // cancel under the NEXT batch's collector).
      await this.state.storage.delete('launchQueued');
      await this.state.storage.delete('resumedHeld');
      await this.state.storage.delete('launchParallel'); // consumed by THIS dispatch
      await this.state.storage.delete('launchWorkStyle'); // consumed by THIS immutable launch snapshot
      await this.state.storage.delete('launchWorkStyleSource');
      return items;
    });
    if (!buf.length) return;

    const base = buf[buf.length - 1].msg;
    const chatId = base.chat?.id;
    const threadId = threadIdOf(base);
    // Identity of this busy window — read by /run-finished matching and the
    // alarm's /tasks/running poll. Stored before the async dispatch work so a
    // crash mid-flight still leaves a coherent record for the safety nets.
    await this.state.storage.put('busyChatId', chatId);
    await this.state.storage.put('busyThread', threadId);
    const coalescedText = coalesceBuffer(buf);
    const continuation = buf.find(item => item.msg.intakeRoute)?.msg;
    const msg = { ...base, text: coalescedText, intakeItems: buf,
      intakeRoute: continuation?.intakeRoute };
    let stableRequestId = null;
    if (this.env.EXECUTION_BACKEND !== 'control-plane' && buf.every(item => Number.isSafeInteger(item.msg?.message_id))) {
      const bytes = new TextEncoder().encode(`${chatId}:${buf.map(item => item.msg.message_id).join(',')}`);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      stableRequestId = `intake-${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
      const requestIds = await this._busyRequestIds();
      if (!requestIds.includes(stableRequestId)) await this.state.storage.put('busyRequestIds', [...requestIds, stableRequestId]);
    }

    await this.state.storage.delete('receiptDue');
    const initialMsgId = await this._showCollector(chatId, buf.length, base.message_id, threadId,
      this.env.EXECUTION_BACKEND === 'control-plane'
        ? '📨 Передаю собранный ввод на определение интента…'
        : '📨 Передаю собранный input агенту…').catch(error => {
          if (this.env.EXECUTION_BACKEND !== 'control-plane') throw error;
          return null;
        });
    if (initialMsgId) await this.state.storage.put('preparingMsgId', initialMsgId);
    await this.state.storage.delete('collectorMsgId');

    // Safety net: only fires if the run never reports back (lost run-finished
    // push, agent crash). The per-minute alarm ticks poll /tasks/running first.
    await this.state.storage.setAlarm(Date.now() + BUSY_POLL_MS);

    let runAck = null;
    if (this.env.EXECUTION_BACKEND === 'control-plane') {
      const launchKey = JSON.stringify(buf.map(item => item.msg?.message_id));
      const checkpoint = await this.state.storage.get(`cp-launch:${launchKey}`);
      await this.state.storage.put(`cp-launch:${launchKey}`, { ...checkpoint, initialMsgId });
    }
    try {
      // Dynamic import avoids a circular import at module load.
      // mode:'deep' — «▶️ Запустить проработку» запускает НАДЁЖНУЮ (deep) сессию на всём
      // накопленном буфере (#530 §A/§B: единый явный запуск проработки). Утилитарные
      // запросы всё равно перехватит быстрый ответ агента (runQuickAnswer) до deep-пути.
      const { handleMessage } = await import('./handlers/message.js');
      await handleMessage(msg, this.env, { mode: 'deep', ...(parallel ? { parallel: true } : {}), initialMsgId,
        ...(stableRequestId ? { requestId: stableRequestId } : {}),
        workStyle: launchWorkStyle, workStyleSource: launchWorkStyleSource,
        ...(this.env.EXECUTION_BACKEND === 'control-plane' ? { collectorStatusHandled: true } : {}),
        onRunAccepted: (ack) => { runAck = ack || null; },
        onIntakePrepared: async (index, prepared) => {
          buf[index] = { ...buf[index], msg: prepared };
          await this.state.storage.put('launching', buf);
        },
      });
      if (runAck) {
        if (this.env.EXECUTION_BACKEND === 'control-plane') {
          await this._recordControlPlaneAck(runAck, buf);
        }
        // Пакет стал задачей: снимаем ожидание наружу и СВЯЗЫВАЕМ его с taskId
        // (arch#132 R9). Связь берётся из ack'а запуска, поэтому гонять batchId
        // через конверт приёма не нужно. Пакет при этом УЖЕ взят из буфера, так
        // что следующая пачка получит новый batchId.
        const launchedBatchId = await this._exclusive(async () => this._nextBatchLocked(chatId, threadIdOf(base)));
        await this._closePending(this.env, launchedBatchId, 'launched', runAck.taskId ?? null);
        // requestId is what the agent echoes back in run-finished. The outbox
        // ack has no requestId field — its taskId IS the dispatch requestId.
        const dispatchRequestId = runAck.requestId || (runAck.outbox ? runAck.taskId : null) || null;
        if (dispatchRequestId) {
          const ids = (await this._busyRequestIds()).filter(id => id !== stableRequestId);
          if (!ids.includes(dispatchRequestId)) await this.state.storage.put('busyRequestIds', [...ids, dispatchRequestId]);
          // Race: the window's first run reported finished while this dispatch
          // was still in flight and released the hold — reopen it for THIS run.
          if (!(await this.state.storage.get('busy'))) {
            await this.state.storage.put('busy', true);
            await this.state.storage.put('busySince', Date.now());
            await this.state.storage.setAlarm(Date.now() + BUSY_POLL_MS);
          }
        }
        if (runAck.outbox) {
          await this.state.storage.put('busyViaOutbox', true);
          await this.state.storage.put('busyViaOutboxAt', Date.now());
        }
        await this.state.storage.delete('launching');
        await this.state.storage.delete('retryBatchAttempts');
        // busy intentionally KEPT: the run's lifetime owns it now (#1527 F1).
        await this.state.storage.setAlarm(Date.now() + BUSY_POLL_MS);
      } else {
        if (this.env.EXECUTION_BACKEND === 'control-plane') return;
        // handleMessage resolved without reaching the agent (project picker,
        // oversized file, supplement draft, …) — no run to wait for.
        await this._exclusive(async () => this._releaseBusyLocked());
      }
    } catch (err) {
      if (this.env.EXECUTION_BACKEND === 'control-plane') {
        await this._handleControlPlaneLaunchFailure(err, buf);
        await this.state.storage.setAlarm(Date.now() + BUSY_POLL_MS);
        return;
      }
      // Stop automatic retries after three failures, but preserve the complete
      // batch and preparation progress for explicit recovery. New input stays usable.
      const isPrepFailure = err?.code === 'INTAKE_PREPARATION_FAILED';
      const isUnknownLaunch = !!stableRequestId && !isPrepFailure && err?.rejected !== true;
      const attempts = isPrepFailure ? ((await this.state.storage.get('retryBatchAttempts')) || 0) + 1 : 0;
      const giveUp = isPrepFailure && attempts >= 3;
      const failureId = giveUp ? crypto.randomUUID() : null;
      const unknownToken = isUnknownLaunch ? crypto.randomUUID() : null;
      const session = unknownToken ? await getSession(this.env.SESSIONS, chatId, threadId).catch(() => null) : null;
      await this._exclusive(async () => this.state.storage.transaction(async tx => {
        if (unknownToken) {
          const messageIds = buf.map(item => item.msg?.message_id);
          await tx.put(`legacy-unknown:${unknownToken}`, { state: 'unknown', requestId: stableRequestId,
            messageIds, items: buf, chatId, threadId, createdAt: Date.now() });
          await tx.put(`legacy-unknown-dismiss:${unknownToken}`, { status: 'pending', requestId: stableRequestId,
            messageId: null, username: session?.username || null, chatId, threadId });
          await tx.delete('retryBatchAttempts');
          await tx.delete('retryBatch');
          await tx.delete('launching');
        } else if (giveUp) {
          await tx.put(`failed:${failureId}`, { id: failureId, items: buf, failedAt: Date.now(),
            messageId: err.intakeMessageId || null, status: err.cause?.status || null });
          await tx.delete('retryBatchAttempts');
        } else {
          await tx.put('retryBatch', buf);
          if (isPrepFailure) await tx.put('retryBatchAttempts', attempts);
        }
        if (!unknownToken) await tx.delete('launching');
      }));
      if (unknownToken) {
        const sent = await sendKeyboardTracked(this.env, chatId,
          '⚠️ Подтверждение запуска не получено. Не могу подтвердить, принял ли агент задачу. Автоматически её не повторяю.',
          [[{ text: '⏸ Не ждать эту задачу', callback_data: `intake_dismiss_unknown|${unknownToken}` }]],
          {}, threadId).catch(() => null);
        if (Number.isSafeInteger(sent?.result?.message_id)) {
          await this.state.storage.put(`legacy-unknown-dismiss:${unknownToken}`, {
            status: 'pending', requestId: stableRequestId, messageId: sent.result.message_id,
            username: session?.username || null, chatId, threadId,
          });
        }
        console.error(`[intake ${chatId}] launch outcome unknown; retained request ${stableRequestId || 'without-id'}`);
        return;
      }
      await sendTracked(this.env, chatId,
        giveUp
          ? '⚠️ Вложение не удалось подготовить после нескольких попыток. Сообщения и готовые расшифровки сохранены для восстановления. Новые задачи можно отправлять; для возврата этой пачки обратись в поддержку.'
          : isPrepFailure
          ? '⚠️ Не удалось подготовить вложение. Пачка и ссылки на исходные сообщения сохранены. Повтори запуск позже — отправлять всё заново не нужно.'
          : '⚠️ Подтверждение запуска не получено. Вся пачка сохранена — повторный запуск проверит, была ли задача уже принята, и не создаст дубль.',
        threadId);
      console.error(`[intake ${chatId}] batch preparation failed (attempt ${attempts || 1}${giveUp ? ', gave up' : ''}):`, err?.cause?.message || err?.message);
      // Dispatch failed before/while reaching the agent — nothing is running.
      await this._exclusive(async () => this._releaseBusyLocked());
    } finally {
      if (this.env.EXECUTION_BACKEND === 'control-plane') this.cpDispatches--;
    }
    if (!(await this.state.storage.get('busy'))) {
      // Released above (no ack / dispatch failure): finish what the old
      // finally-path did — media recovery + collector for held messages. When
      // busy is still set the run owns it; release happens via run-finished,
      // the outbox permanent-reject path, the alarm poll, or BUSY_MAX_MS.
      await this._afterBusyRelease();
    }
  }

  // ── Busy = lifetime of the run (epic #1527 PR1) ─────────────────────────────
  // _dispatch sets `busy` and keeps it after a successful enqueue; it is
  // cleared by _releaseBusyLocked on: agent run-finished (matched requestId),
  // outbox permanent reject, the alarm's /tasks/running?chatId= poll (lost
  // push / agent restart), or BUSY_MAX_MS. Until then every new message lands
  // in the buffer as held — never as a second queued task (US-SUP-01 / CH-10).

  // The set of live run requestIds the current busy window covers — the scalar
  // `busyRequestId` before it (kept as a read fallback so a deploy with a run in
  // flight does not orphan the hold). Usually one id; the explicit parallel
  // launch (RC-03) appends a second.
  async _busyRequestIds() {
    const ids = await this.state.storage.get('busyRequestIds');
    if (Array.isArray(ids)) return ids;
    const legacy = await this.state.storage.get('busyRequestId');
    return legacy ? [legacy] : [];
  }

  // Must be called inside _exclusive: clear the whole busy record.
  async _releaseBusyLocked() {
    await this.state.storage.delete('cpBusyRequests');
    await this.state.storage.delete('cpUnresolvedLaunches');
    await this.state.storage.delete('busy');
    await this.state.storage.delete('busySince');
    await this.state.storage.delete('busyRequestIds');
    await this.state.storage.delete('busyRequestId'); // legacy scalar (pre-set key)
    await this.state.storage.delete('busyViaOutbox');
    await this.state.storage.delete('busyViaOutboxAt');
    await this.state.storage.delete('busyChatId');
    await this.state.storage.delete('busyThread');
    await this.state.storage.delete('launching');
    // The queue intent itself (launchAfterRelease) is consumed by
    // _afterBusyRelease right after this — but the ↩️ UI flag dies with the run
    // that justified it, so the first post-release collector can't wear a stale
    // cancel button (dispatch clears it again for its own «📨» status).
    await this.state.storage.delete('launchQueued');
    await this.state.storage.deleteAlarm();
  }

  // Post-release side effects (media recovery + collector for held messages).
  // Never inside the lock — Telegram I/O.
  async _afterBusyRelease() {
    await this._recoverMedia();
    // RC-04/RC-05 first: the user already chose «стоп + запуск», and this is the
    // moment the stopped run is provably gone. Launching here (before any other
    // remembered intent) is what keeps it to exactly one run.
    if (await this._consumeStopLaunch()) return;
    const remaining = [...((await this.state.storage.get('retryBatch')) || []), ...((await this.state.storage.get('buf')) || [])];
    if (!remaining.length) {
      await this.state.storage.delete('launchAfterRelease');
      await this.state.storage.delete('launchParallel'); // staged intent with no batch
      return;
    }
    if (remaining.some(i => i.mediaPending)) return; // _mediaResult shows the collector later
    // The user already tapped «▶️ Запустить» during the run — honour it now
    // instead of re-offering the button and waiting for another tap.
    // ⛔ Стоп (#1856) cleared launchAfterRelease already; `stopped` is the belt to
    // those braces — a run that ends after a stop never launches the held batch.
    if ((await this.state.storage.get('launchAfterRelease')) && !(await this.state.storage.get('stopped'))) {
      await this.state.storage.delete('launchAfterRelease');
      await this._dispatch();
      return;
    }
    // A remembered preparing-tap (launchWhenReady, incl. the parallel one) with
    // nothing pending left: start it now instead of re-offering the button.
    if (await this.state.storage.get('launchWhenReady')) {
      await this.state.storage.delete('launchWhenReady');
      await this._dispatch();
      return;
    }
    await this.state.storage.delete('launchAfterRelease');
    const last = remaining[remaining.length - 1];
    await this._showCollector(last.msg.chat?.id, remaining.length, last.msg.message_id, threadIdOf(last.msg));
  }

  // Safety-net poll: ask the agent whether ANY run for this chat is still
  // accepted-not-finished. The chat-scoped counter is bumped synchronously at
  // runTask entry (before /run's 202) and released together with the
  // run-finished push, so `running:false` here means the push was lost or the
  // agent process restarted (in-memory counter reset). Outbox dispatches are
  // excluded: their counter only appears when the outbox actually delivers,
  // and releasing early while a job is still queued reopens the double-run hole.
  async _handleControlPlaneLaunchFailure(error, items) {
    const launchKey = JSON.stringify(items.map(item => item.msg?.message_id));
    const base = items.at(-1)?.msg;
    const checkpoint = await this.state.storage.get(`cp-launch:${launchKey}`);
    const refusedMedia = !mediaEnabled(this.env) && items.some(item => !!mediaOf(item.msg));
    const snapshotRequestId = checkpoint?.snapshotRequestId;
    const acceptance = snapshotRequestId && await this.state.storage.get(`cp-acceptance:${snapshotRequestId}`);
    const busyRequests = (await this.state.storage.get('cpBusyRequests')) || [];
    const unsupportedMediaRejectedBeforeAdmission = refusedMedia && !acceptance?.receipt?.durable
      && !busyRequests.includes(snapshotRequestId);
    // An explicit CP auth rejection is a definitive pre-admission failure:
    // the intake endpoint rejects the request before writing a receipt. Keep
    // the batch for an explicit retry, but do not leave the chat in an
    // "outcome unknown" state forever. Other HTTP failures remain unknown;
    // in particular, never infer non-admission from a timeout or 5xx.
    const knownNoAdmission = error?.code === 'CONTROL_PLANE_NO_ADMISSION' ||
      error?.name === 'ControlPlaneError' && [401, 403].includes(error.status);
    const confirmedNoAdmission = knownNoAdmission && !acceptance?.receipt?.durable
      && !busyRequests.includes(snapshotRequestId);
    if (confirmedNoAdmission || (error?.code === 'INTAKE_PREPARATION_FAILED' && (!snapshotRequestId || unsupportedMediaRejectedBeforeAdmission))) {
      const released = await this._exclusive(async () => {
        if (refusedMedia) {
          // This batch cannot be prepared in the active CP profile. Do not put it
          // back into retryBatch: every later attempt would fail on the same media.
          await this.state.storage.delete('retryBatch');
          await this.state.storage.delete('retryBatchAttempts');
        } else {
          await this.state.storage.put('retryBatch', items.map(item => ({ ...item, heldWhileBusy: true })));
        }
        const unresolved = (await this.state.storage.get('cpUnresolvedLaunches')) || [];
        const remaining = unresolved.filter(key => key !== launchKey);
        await this.state.storage.put('cpUnresolvedLaunches', remaining);
        await this.state.storage.delete(`cp-launch:${launchKey}`);
        const launching = await this.state.storage.get('launching');
        if (JSON.stringify(launching?.map(item => item.msg?.message_id)) === launchKey) await this.state.storage.delete('launching');
        if (remaining.length || ((await this.state.storage.get('cpBusyRequests')) || []).length) return false;
        await this._releaseBusyLocked();
        return true;
      });
      await sendTracked(this.env, base?.chat?.id, refusedMedia
        ? '⚠️ Вложения пока не поддерживаются в этом тестовом режиме. Задачу не запускал, неподдерживаемую порцию сбросил. Отправь запрос текстом или начни новую порцию.'
        : knownNoAdmission
          ? '⚠️ Подтверждение запуска не получено до передачи задачи. Запуск не создавал; сообщения сохранены для повтора.'
          : '⚠️ Вложения сохранены. Передача новому исполнителю ещё не подключена; задача не запущена. Пачку можно запустить повторно после подключения вложений.',
        {}, threadIdOf(base)).catch(() => null);
      if (released) await this._afterBusyRelease();
      return;
    }
    if (checkpoint?.notified) return;
    if (checkpoint) await this.state.storage.put(`cp-launch:${launchKey}`, { ...checkpoint, notified: true });
    const stopWindow = await this.state.storage.get('cpStopWindow');
    const isStopDependency = stopWindow?.pending && (stopWindow.admissionLaunchKeys || []).includes(launchKey);
    if (isStopDependency && !stopWindow.userDismissedLaunchKeys?.includes(launchKey)) {
      const token = crypto.randomUUID();
      await this.state.storage.put(`cp-unknown-dismiss:${token}`, { launchKey, intentId: stopWindow.intentId,
        username: stopWindow.username, messageId: null });
      const sent = await sendKeyboardTracked(this.env, base?.chat?.id,
        '⚠️ Подтверждение не получено; сверяю ту же задачу. Собранный ввод сохранён.',
        [[{ text: '⏸ Не ждать старую задачу', callback_data: `intake_dismiss_unknown|${token}` }]],
        {}, threadIdOf(base)).catch(() => null);
      const messageId = sent?.result?.message_id;
      if (Number.isSafeInteger(messageId)) await this.state.storage.put(`cp-unknown-dismiss:${token}`, {
        launchKey, intentId: stopWindow.intentId, username: stopWindow.username, messageId,
      });
    } else await sendTracked(this.env, base?.chat?.id,
      '⚠️ Подтверждение не получено; сверяю ту же задачу. Собранный ввод сохранён.',
      {}, threadIdOf(base)).catch(() => null);
  }

  async _readControlPlaneStopTargets(source) {
    const threadId = source?.threadId ?? null;
    if (!source || typeof source.username !== 'string' || !source.username ||
        !Number.isSafeInteger(source.chatId) || !source.chatId ||
        (threadId !== null && (!Number.isSafeInteger(threadId) || threadId <= 0))) throw new Error('Invalid stop scope');
    const profileId = controlPlaneClient(this.env).config.profileId;
    const session = await getSession(this.env.SESSIONS, source.chatId, threadId);
    if (session?.username !== source.username) throw new Error('Stop owner mismatch');
    const scope = await this.state.storage.get('cpScope');
    const window = await this.state.storage.get('cpStopWindow');
    if (scope && (scope.chatId !== source.chatId || scope.threadId !== threadId || scope.profileId !== profileId)) throw new Error('Stop conversation mismatch');
    if (window && (window.username !== source.username || window.chatId !== source.chatId ||
        window.threadId !== threadId || window.profileId !== profileId)) throw new Error('Stop window mismatch');
    if (!scope && !window) throw new Error('No stop scope proof');
    const intent = window || {
      intentId: crypto.randomUUID(), restart: false, groups: [], tasks: [], pending: true,
      username: source.username, chatId: source.chatId, threadId, profileId,
    };
    const ids = [...new Set([...(intent.admissionRequestIds || []), ...(intent.tasks || []).map(task => task.requestId)])].sort();
    const unresolvedAtStop = new Set(intent.admissionLaunchKeys || []);
    const unresolvedLaunches = (await this.state.storage.get('cpUnresolvedLaunches')) || [];
    const admissionBarrierComplete = ![...unresolvedAtStop].some(key => unresolvedLaunches.includes(key))
      && !(this.cpDispatches > 0 && unresolvedAtStop.size > 0);
    let unresolved = !admissionBarrierComplete;
    if (await this.state.storage.get('busy') && !ids.length) unresolved = true;
    const grouped = new Map();
    for (const requestId of ids) {
      const record = await this.state.storage.get(`cp-acceptance:${requestId}`);
      const receipt = record?.receipt;
      const snapshot = await this._readSnapshot(requestId);
      const envelope = snapshot?.body?.controlPlaneEnvelope;
      if (typeof requestId !== 'string' || receipt?.requestId !== requestId || receipt?.profileId !== profileId ||
          receipt?.durable !== true || typeof receipt?.userTaskId !== 'string' || !receipt.userTaskId ||
          snapshot?.body?.username !== source.username || envelope?.requestId !== requestId || envelope?.profileId !== profileId ||
          !snapshot?.items?.length || snapshot.items.some(item => item.msg?.chat?.id !== source.chatId || threadIdOf(item.msg) !== threadId)) {
        return { ...intent, username: source.username, chatId: source.chatId, threadId, profileId,
          admissionBarrierComplete: false, admissionRequestIds: ids, unresolved: true, groups: [], tasks: [] };
      }
      const saved = intent.tasks?.find(task => task.requestId === requestId);
      if (saved && (saved.userTaskId !== receipt.userTaskId || saved.profileId !== profileId)) throw new Error('Stop task mismatch');
      const conversationId = envelope.conversationRef;
      if (typeof conversationId !== 'string' || !conversationId) {
        return { ...intent, username: source.username, chatId: source.chatId, threadId, profileId,
          admissionBarrierComplete: false, admissionRequestIds: ids, unresolved: true, groups: [], tasks: [] };
      }
      if (!grouped.has(conversationId)) grouped.set(conversationId, []);
      grouped.get(conversationId).push({ requestId, userTaskId: receipt.userTaskId, profileId, receiptId: receipt.receiptId });
    }
    if (!grouped.size && scope?.conversationId) grouped.set(scope.conversationId, []);
    const groups = [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([conversationId, tasks]) => ({
      conversationId,
      windowId: '',
      restart: intent.restart === true && (intent.previousGroups || []).some(previous =>
        previous.conversationId === conversationId && previous.stopConfirmed === true),
      admissionRequestIds: tasks.map(task => task.requestId).sort(),
      tasks,
    }));
    // Hash the conversation identity so the stable per-conversation window ID is
    // bounded and does not expose conversation data in CP diagnostics.
    for (const group of groups) {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(group.conversationId));
      const suffix = Array.from(new Uint8Array(digest).slice(0, 8), value => value.toString(16).padStart(2, '0')).join('');
      group.windowId = `tgstop-${intent.intentId}-${suffix}`;
    }
    return { ...intent, username: source.username, chatId: source.chatId, threadId, profileId,
      admissionBarrierComplete: !unresolved, admissionRequestIds: ids, unresolved,
      noRemoteStop: groups.length === 0 && ids.length === 0 && !unresolved && !(await this.state.storage.get('busy')),
      groups, tasks: groups.flatMap(group => group.tasks) };
  }

  async _driveControlPlaneStop(source) {
    if (controlPlaneStopDisabled(this.env)) throw controlPlaneStopDisabledError();
    const prepared = await this._exclusive(async () => this._readControlPlaneStopTargets(source));
    if (prepared.unresolved) {
      await this._exclusive(async () => {
        const current = await this.state.storage.get('cpStopWindow');
        if (current?.intentId === prepared.intentId) {
          await this.state.storage.put('cpStopWindow', { ...current, admissionRequestIds: prepared.admissionRequestIds,
            pending: true, unresolved: true });
          await this.state.storage.setAlarm(Date.now() + BUSY_POLL_MS);
        }
      });
      return { ...prepared, snapshotId: null, stopConfirmed: false };
    }
    if (prepared.noRemoteStop) {
      const saved = await this._exclusive(async () => {
        const current = await this.state.storage.get('cpStopWindow');
        if (!current || current.intentId !== prepared.intentId) return false;
        await this.state.storage.put('cpStopWindow', { ...current, pending: false, unresolved: false,
          stopConfirmed: true, locallyNoRun: true, tasks: [], groups: [], updatedAt: Date.now() });
        if (!(await this.state.storage.get('busy'))) await this.state.storage.deleteAlarm();
        return true;
      });
      return { ...prepared, unresolved: !saved, stopConfirmed: saved, snapshotId: null, tasks: [] };
    }
    const client = controlPlaneClient(this.env);
    const results = [];
    for (const group of prepared.groups) {
      const result = await client.stopTargets({ conversationId: group.conversationId,
        windowId: group.windowId, admissionBarrierComplete: true,
        admissionRequestIds: group.admissionRequestIds, restart: group.restart });
      if (result.profileId !== prepared.profileId || result.conversationId !== group.conversationId) {
        throw new Error('Control plane stop identity mismatch');
      }
      results.push({ ...result, windowId: group.windowId });
    }
    const confirmed = results.length > 0 && results.every(result => !result.unresolved && result.stopConfirmed);
    const saved = await this._exclusive(async () => {
      const current = await this.state.storage.get('cpStopWindow');
      if (!current || current.intentId !== prepared.intentId) return false;
      const tasks = results.flatMap(result => result.tasks);
      await this.state.storage.put('cpStopWindow', { ...current, admissionRequestIds: prepared.admissionRequestIds,
        groups: results, tasks,
        pending: !confirmed, unresolved: !confirmed, stopConfirmed: confirmed,
        snapshotId: results.length === 1 ? results[0].snapshotId : null, updatedAt: Date.now() });
      if (!confirmed) await this.state.storage.setAlarm(Date.now() + BUSY_POLL_MS);
      else if (!(await this.state.storage.get('busy'))) await this.state.storage.deleteAlarm();
      return true;
    });
    return { ...prepared, groups: results, tasks: results.flatMap(result => result.tasks),
      unresolved: !saved || !confirmed, stopConfirmed: saved && confirmed,
      snapshotId: results.length === 1 ? results[0].snapshotId : null };
  }

  async _recordControlPlaneAck(ack, items) {
    const saved = await this.state.storage.get(`cp-acceptance:${ack.requestId}`);
    const snapshot = await this._readSnapshot(ack.requestId);
    const profileId = controlPlaneClient(this.env).config.profileId;
    if (ack.controlPlane !== true || ack.durable !== true || !saved ||
        saved.receipt.userTaskId !== ack.userTaskId || ack.taskId !== ack.userTaskId ||
        saved.receipt.requestId !== ack.requestId || saved.receipt.profileId !== profileId ||
        snapshot?.body?.controlPlaneEnvelope?.requestId !== ack.requestId ||
        JSON.stringify(snapshot?.items?.map(item => item.msg?.message_id)) !== JSON.stringify(items.map(item => item.msg?.message_id))) {
      throw new Error('Control plane acceptance is not persisted');
    }
    await this._exclusive(async () => this.state.storage.transaction(async tx => {
      const ids = (await tx.get('cpBusyRequests')) || [];
      await tx.put('cpBusyRequests', [...new Set([...ids, ack.requestId])]);
      const launchKey = JSON.stringify(items.map(item => item.msg?.message_id));
      const stopWindow = await tx.get('cpStopWindow');
      if (stopWindow?.pending && (stopWindow.admissionLaunchKeys || []).includes(launchKey)) {
        await tx.put('cpStopWindow', { ...stopWindow,
          admissionRequestIds: [...new Set([...(stopWindow.admissionRequestIds || []), ack.requestId])].sort() });
      }
      const unresolved = (await tx.get('cpUnresolvedLaunches')) || [];
      await tx.put('cpUnresolvedLaunches', unresolved.filter(key => key !== launchKey));
      await tx.delete(`cp-launch:${launchKey}`);
    }));
  }

  async _recoverControlPlaneLaunch() {
    const checkpoint = await this._exclusive(async () => {
      if (this.cpDispatches) return null;
      const unresolved = (await this.state.storage.get('cpUnresolvedLaunches')) || [];
      if (!unresolved.length) return null;
      const saved = await this.state.storage.get(`cp-launch:${unresolved[0]}`);
      if (!saved) return null;
      if ((await this.state.storage.get('cpStopWindow'))?.pending && !saved.parallel) return null;
      const client = controlPlaneClient(this.env);
      if (saved.profileId !== client.config.profileId || saved.botUsername !== client.config.botUsername) return null;
      this.cpDispatches++;
      return saved;
    });
    if (!checkpoint) return false;
    try {
      let ack;
      const { handleMessage } = await import('./handlers/message.js');
      await handleMessage(checkpoint.msg, this.env, {
        mode: 'deep', ...(checkpoint.parallel ? { parallel: true } : {}),
        workStyle: WORK_STYLES.includes(checkpoint.workStyle) ? checkpoint.workStyle : 'auto',
        workStyleSource: checkpoint.workStyleSource === 'explicit' ? 'explicit' : 'default',
        initialMsgId: checkpoint.initialMsgId,
        collectorStatusHandled: true,
        onRunAccepted: value => { ack = value; },
      });
      if (!ack) {
        // handleMessage only returns without an ACK on paths that finish before
        // runTask/CP admission (for example an oversized or unsupported item).
        // Retire this exact checkpoint so the busy window cannot wedge forever.
        await this._handleControlPlaneLaunchFailure(
          Object.assign(new Error('Launch returned without a durable acceptance receipt'), { code: 'CONTROL_PLANE_NO_ADMISSION' }),
          checkpoint.msg.intakeItems,
        );
        return false;
      }
      await this._recordControlPlaneAck(ack, checkpoint.msg.intakeItems);
      const batchId = await this._exclusive(async () => this._nextBatchLocked(
        checkpoint.msg.chat.id, threadIdOf(checkpoint.msg)));
      await this._closePending(this.env, batchId, 'launched', ack.taskId);
      const launching = await this.state.storage.get('launching');
      if (JSON.stringify(launching?.map(item => item.msg?.message_id)) ===
          JSON.stringify(checkpoint.msg.intakeItems.map(item => item.msg?.message_id))) {
        await this.state.storage.delete('launching');
      }
      return true;
    } catch (error) {
      await this._handleControlPlaneLaunchFailure(error, checkpoint.msg.intakeItems);
      return false;
    } finally {
      this.cpDispatches--;
    }
  }

  async _queueControlPlaneCollectorCleanup(requestId, receipt, row, snapshot) {
    const messageId = snapshot.body.initialMsgId;
    if (!Number.isSafeInteger(messageId) || messageId <= 0) return;
    const message = snapshot.items.at(-1)?.msg;
    const intent = { requestId, userTaskId: receipt.userTaskId, profileId: receipt.profileId,
      generation: row.generation, messageId, chatId: message.chat.id,
      text: row.status === 'done' ? '✅ Готово. Результат отправлен отдельным сообщением.'
        : row.status === 'failed' ? '❌ Задача завершилась ошибкой. Подробности отправлены отдельным сообщением.'
          : '⛔ Задача отменена. Статус отправлен отдельным сообщением.' };
    await this._exclusive(async () => this.state.storage.transaction(async tx => {
      if (await tx.get(`input-message:${messageId}`) !== requestId) return;
      const key = `cp-collector-cleanup:${requestId}`;
      if ((await tx.get(key))?.state === 'done') return;
      await tx.put(key, { ...intent, state: 'pending' });
      const pending = (await tx.get('cpCollectorCleanupRequests')) || [];
      await tx.put('cpCollectorCleanupRequests', [...new Set([...pending, requestId])]);
    }));
    await this._recoverControlPlaneCollectorCleanup();
  }

  async _recoverControlPlaneCollectorCleanup() {
    const previous = this.uiMutation;
    let release;
    this.uiMutation = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      const selected = await this._exclusive(async () => this.state.storage.transaction(async tx => {
        const pending = (await tx.get('cpCollectorCleanupRequests')) || [];
        const batch = pending.slice(0, 8);
        if (batch.length) await tx.put('cpCollectorCleanupRequests', [...pending.slice(8), ...batch]);
        return batch;
      }));
      for (const requestId of selected) {
        const key = `cp-collector-cleanup:${requestId}`;
        const intent = await this.state.storage.get(key);
        if (intent?.state !== 'pending' || intent.profileId !== controlPlaneClient(this.env).config.profileId
            || await this.state.storage.get(`input-message:${intent.messageId}`) !== requestId) continue;
        const result = await editMessage(this.env.BOT_TOKEN, intent.chatId, intent.messageId, intent.text,
          { reply_markup: { inline_keyboard: STATUS_BTN } }).catch(() => null);
        if (!result?.ok && !(result?.error_code === 400 && /message is not modified|message to edit not found/i.test(result.description || ''))) continue;
        await this._exclusive(async () => this.state.storage.transaction(async tx => {
          const current = await tx.get(key);
          if (JSON.stringify(current) !== JSON.stringify(intent)) return;
          await tx.put(key, { ...intent, state: 'done' });
          await tx.put('cpCollectorCleanupRequests', ((await tx.get('cpCollectorCleanupRequests')) || []).filter(value => value !== requestId));
          if (await tx.get('preparingMsgId') === intent.messageId) await tx.delete('preparingMsgId');
        }));
      }
    } finally { release(); }
    await this._ensureControlPlaneCollectorCleanupAlarm();
  }

  async _ensureControlPlaneCollectorCleanupAlarm() {
    if (this.env.EXECUTION_BACKEND !== 'control-plane'
        || !((await this.state.storage.get('cpCollectorCleanupRequests')) || []).length) return;
    await this._ensureAlarmBy(Date.now() + BUSY_POLL_MS);
  }

  async _ensureAlarmBy(retryAt) {
    const now = Date.now();
    const alarmAt = await this.state.storage.getAlarm();
    if (!alarmAt || alarmAt <= now || alarmAt > retryAt) await this.state.storage.setAlarm(retryAt);
  }

  async _pollControlPlaneTasks({ launch = false } = {}) {
    if (this.cpDispatches) return false;
    try { await this._recoverControlPlaneLaunch(); } catch { return false; }
    if (this.cpDispatches || (await this._activeUnresolvedLaunches()).length) return false;
    const ids = (await this.state.storage.get('cpBusyRequests')) || [];
    if (!ids.length) return false;
    try {
      const client = controlPlaneClient(this.env);
      const profileId = client.config.profileId;
      const terminal = [];
      const unresolved = [];
      const stopPending = (await this.state.storage.get('cpStopWindow'))?.pending === true;
      for (const requestId of ids) {
        const record = await this.state.storage.get(`cp-acceptance:${requestId}`);
        const receipt = record?.receipt;
        if (!receipt || receipt.requestId !== requestId || receipt.profileId !== profileId || receipt.durable !== true) return false;
        const { value } = await client.request('POST', '/status', { body: { taskId: receipt.userTaskId } });
        const row = value?.taskStore;
        if (row?.id !== receipt.userTaskId || row?.profile_id !== profileId) return false;
        const runs = Array.isArray(value?.runs) ? value.runs : [];
        const settledRuns = runs.every(run => ['done', 'failed', 'cancelled', 'unknown'].includes(run?.status));
        const outcomeUnknown = (row.status === 'unknown' ||
          (runs.length > 0 && runs.some(run => run?.status === 'unknown'))) && settledRuns &&
          value?.awaiting?.status !== 'open';
        if (outcomeUnknown) {
          unresolved.push(requestId);
          continue;
        }
        if (!isTerminalTaskStatus(row.status)) {
          let routed;
          const routingKnown = record.routingOutcome?.known === true && record.routingOutcome.publicationComplete === true;
          const routingDeferred = stopPending && controlPlaneStopDisabled(this.env);
          if (!routingKnown && !routingDeferred) {
            if (stopPending) return false;
            routed = await client.route(receipt.userTaskId);
            if (!routed || typeof routed !== 'object' || Array.isArray(routed) || Object.hasOwn(routed, 'raw')) return false;
          }
          if (!routingKnown && !routingDeferred && routed?.degraded === true) {
            const snapshot = await this._readSnapshot(requestId);
            const envelope = snapshot?.body?.controlPlaneEnvelope;
            const message = snapshot?.items?.at(-1)?.msg;
            if (envelope?.requestId !== requestId || envelope.profileId !== profileId ||
                typeof envelope.conversationRef !== 'string' || !envelope.conversationRef ||
                !Number.isSafeInteger(message?.chat?.id) || !message.chat.id) return false;
            await publishRoutingDegradation(this.env, receipt, routed,
              { chatId: message.chat.id, threadId: threadIdOf(message) },
              `${envelope.conversationRef}-b${requestId.slice(-24)}`);
          }
          if (!routingKnown && !routingDeferred) {
            await this._exclusive(async () => this.state.storage.transaction(async tx => {
              const key = `cp-acceptance:${requestId}`;
              const current = await tx.get(key);
              if (current?.receipt?.userTaskId !== receipt.userTaskId || current.receipt.profileId !== profileId ||
                  current.receipt.requestId !== requestId) throw new Error('Routing receipt changed');
              await tx.put(key, { ...current, routingOutcome: {
                known: true, publicationComplete: true, degraded: routed.degraded === true,
                continuationIssued: routed.continuation?.issued === true,
              } });
            }));
          }
          return false;
        }
        if (!Number.isSafeInteger(row.generation) || row.generation < 1 ||
            !Number.isSafeInteger(receipt.providerAcceptedAt) || receipt.providerAcceptedAt <= 0) return false;
        const snapshot = await this._readSnapshot(requestId);
        const envelope = snapshot?.body?.controlPlaneEnvelope;
        const message = snapshot?.items?.at(-1)?.msg;
        if (envelope?.requestId !== requestId || envelope.profileId !== profileId ||
            typeof envelope.conversationRef !== 'string' || !envelope.conversationRef ||
            !Number.isSafeInteger(message?.chat?.id) || !message.chat.id) return false;
        const deliveryId = `terminal:${receipt.userTaskId}:g${row.generation}`;
        const answer = typeof row.result === 'string' ? row.result : row.result?.answer;
        const label = row.status === 'done' ? 'Готово. Текст результата отсутствует.'
          : row.status === 'failed' ? 'Ошибка исполнителя.' : 'Отменено.';
        const outbox = new TgDeliveryOwnerClient(this.env);
        const queued = await outbox.enqueue({ deliveryId, taskAcceptedAt: receipt.providerAcceptedAt,
          conversationId: `${envelope.conversationRef}-b${requestId.slice(-24)}`,
          userTaskId: receipt.userTaskId,
          destination: { chatId: message.chat.id, threadId: threadIdOf(message) },
          requestId: deliveryId, type: 'message',
          text: row.status === 'done' && typeof answer === 'string' && answer.trim() ? answer : label });
        if (queued?.record?.deliveryId !== deliveryId || queued.record.status === 'quarantined') return false;
        const deliveryIndependent = row.status === 'failed' || row.status === 'cancelled';
        try { await outbox.drain(); } catch { if (!deliveryIndependent) return false; }
        const delivered = await outbox.load(deliveryId).catch(() => null);
        if (!deliveryIndependent && (delivered?.deliveryId !== deliveryId || delivered.status !== 'sent')) return false;
        await this._queueControlPlaneCollectorCleanup(requestId, receipt, row, snapshot);
        terminal.push(requestId);
      }
      const released = await this._exclusive(async () => {
        if (this.cpDispatches || ((await this.state.storage.get('cpUnresolvedLaunches')) || []).length || !(await this.state.storage.get('busy')) ||
            JSON.stringify((await this.state.storage.get('cpBusyRequests')) || []) !== JSON.stringify(ids)) return false;
        await this.state.storage.transaction(async tx => {
          for (const requestId of terminal) {
            const key = `cp-acceptance:${requestId}`;
            const record = await tx.get(key);
            await tx.put(key, { ...record, terminal: true });
          }
          for (const requestId of unresolved) {
            const key = `cp-acceptance:${requestId}`;
            const record = await tx.get(key);
            await tx.put(key, { ...record, outcomeUnknown: true });
          }
        });
        await this._releaseBusyLocked();
        if (launch) await this.state.storage.put('launchAfterRelease', true);
        return true;
      });
      if (released) await this._afterBusyRelease();
      await this._ensureControlPlaneCollectorCleanupAlarm();
      if (controlPlaneStopDisabled(this.env) && (await this.state.storage.get('cpStopWindow'))?.pending) {
        await this._ensureAlarmBy(Date.now() + BUSY_POLL_MS);
      }
      return released;
    } catch {
      return false;
    }
  }

  async _pollRunFinishedIfIdle(since, { launch = false } = {}) {
    if (this.env.EXECUTION_BACKEND === 'control-plane') return this._pollControlPlaneTasks({ launch });
    const chatId = await this.state.storage.get('busyChatId');
    if (!chatId || !this.env.AGENT_URL) return false;
    // Outbox dispatches are excluded WHILE THE OUTBOX STILL OWNS THE JOB: their
    // counter only appears when the outbox actually delivers, so `running:false`
    // says nothing about a job still queued, and releasing would reopen the
    // double-run hole. That exclusion used to be permanent, which made a lost or
    // undeliverable outbox job pin the chat until BUSY_MAX_MS — 45 minutes of a
    // chat that accepts messages and never runs them (prod 2026-10-04, chat
    // -5111318625: 33 minutes held, six messages inside, no run).
    //
    // The exclusion is now BOUNDED. Two independent owners already release the hold:
    // the outbox itself on permanent reject, and the outbox on prolonged agent
    // downtime (`run-outbox.js`, releaseIntakeBusy). This grace is the third and
    // last line, for the case where the outbox record itself was lost — then the
    // agent's answer is the only truth left, and a silent `running:false` for this
    // long means there is nothing running to wait for.
    const viaOutbox = await this.state.storage.get('busyViaOutbox');
    if (viaOutbox) {
      const outboxAt = (await this.state.storage.get('busyViaOutboxAt')) || since;
      if (Date.now() - outboxAt < OUTBOX_POLL_GRACE_MS) return false;
      console.log(`[intake ${chatId}] outbox hold exceeded grace (${OUTBOX_POLL_GRACE_MS}ms) — trusting the agent's answer`);
    }
    if (Date.now() - since < 30_000) return false; // warmup: ack → counter visible
    try {
      const res = await fetch(`${this.env.AGENT_URL}/tasks/running?chatId=${encodeURIComponent(chatId)}`, {
        headers: { Authorization: `Bearer ${this.env.AGENT_SECRET || ''}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return false;
      const data = await res.json();
      if (data.running) return false;
      const released = await this._exclusive(async () => {
        if (!(await this.state.storage.get('busy'))) return false;
        await this._releaseBusyLocked();
        if (launch) await this.state.storage.put('launchAfterRelease', true);
        return true;
      });
      if (released) await this._afterBusyRelease();
      return released;
    } catch {
      return false; // transient — next alarm tick retries; BUSY_MAX is the hard cap
    }
  }

  async alarm() {
    try {
      await this._alarm();
    } finally {
      await this._ensureControlPlaneCollectorCleanupAlarm();
    }
  }

  async _alarm() {
    if (this.env.EXECUTION_BACKEND === 'control-plane') {
      await this._recoverMedia();
      await this._recoverControlPlaneCollectorCleanup();
      const stopWindow = await this.state.storage.get('cpStopWindow');
      if (stopWindow?.pending && controlPlaneStopDisabled(this.env)) {
        await this._ensureAlarmBy(Date.now() + BUSY_POLL_MS);
      } else if (stopWindow?.pending) {
        try {
          const result = await this._driveControlPlaneStop({ username: stopWindow.username,
            chatId: stopWindow.chatId, threadId: stopWindow.threadId });
          if (result.stopConfirmed) {
            const items = [...((await this.state.storage.get('retryBatch')) || []), ...((await this.state.storage.get('buf')) || [])];
            const last = items.at(-1)?.msg;
            await this._showCollector(last?.chat?.id ?? stopWindow.chatId, items.length,
              last?.message_id ?? null, last ? threadIdOf(last) : stopWindow.threadId,
              items.length ? null : '⛔ Остановка подтверждена. Новый запуск не выполнялся.');
            return;
          }
        }
        catch {
          await this.state.storage.setAlarm(Date.now() + BUSY_POLL_MS);
        }
        if ((await this.state.storage.get('cpStopWindow'))?.pending) return;
      }
    } else {
      await this._recoverMedia();
    }
    // A «стоп + запуск» choice waiting for its start outranks every timer below
    // (RC-04/RC-05): if the run is gone and the batch is ready, run it now.
    if (await this._consumeStopLaunch()) return;
    const receiptDue = await this.state.storage.get('receiptDue');
    if (receiptDue) {
      const receiptExpired = Date.now() >= receiptDue || (await this.state.storage.get('debounceExpiresAt')) <= Date.now();
      const cpBusy = this.env.EXECUTION_BACKEND === 'control-plane' && await this.state.storage.get('busy');
      if (!receiptExpired && !cpBusy) { await this.state.storage.setAlarm(receiptDue); return; }
      if (receiptExpired) {
        await this.state.storage.delete('receiptDue');
        const items = ((await this.state.storage.get('buf')) || []).sort((a,b) => (a.msg.message_id || 0) - (b.msg.message_id || 0));
        if (items.length) {
          const last = items.at(-1).msg;
          const busy = await this.state.storage.get('busy');
          const queued = busy && !!(await this.state.storage.get('launchQueued'));
          const stopped = !!(await this.state.storage.get('stopped'));
          await this._showCollector(last.chat?.id, items.length, last.message_id, threadIdOf(last),
            queued || stopped ? null : (busy ? heldText(items.length) : null));
          if (!busy && !stopped) await this._consultGate(last.chat?.id, threadIdOf(last));
        }
      }
    }

    // If not busy and media still pending — _recoverMedia re-armed the alarm; wait.
    // _recoverMedia already fired the deadline for anything past MEDIA_DEADLINE_MS,
    // so a genuinely stuck item does not pile up behind this early return.
    const bufCheck = (await this.state.storage.get('buf')) || [];
    if (!(await this.state.storage.get('busy')) && bufCheck.some(i => i.mediaPending)) return;

    // Check once after the quiet period, never on the two-second short-text path.
    const debounceExpiresAt = await this.state.storage.get('debounceExpiresAt');
    if (debounceExpiresAt && await this.state.storage.get('autoPolicy') !== 'quiet-3m-v1') {
      const items = (await this.state.storage.get('buf')) || [];
      if (items.length && !(await this.state.storage.get('busy'))) {
        await this._armAutoDispatch(items.at(-1).msg.chat?.id, items, items.at(-1).msg.message_id, threadIdOf(items.at(-1).msg));
        return;
      }
    }
    if (debounceExpiresAt && Date.now() >= debounceExpiresAt &&
        !(await this.state.storage.get('busy')) && !(await this.state.storage.get('stopped'))) {
      const buf = (await this.state.storage.get('buf')) || [];
      // RC-06: the expiry gate is the LAST automatic door. A batch that only sat
      // in the buffer during a run never walks through it — the run's end shows
      // the menu and the batch waits for the user's explicit choice. The timer is
      // dropped (not left to fire again) so nothing can start it later either.
      if (await this._autoLaunchBlocked(buf)) {
        await this._exclusive(async () => {
          await this.state.storage.delete('debounceExpiresAt');
          await this.state.storage.delete('gateLevel');
        });
        return;
      }
      const snapshot = JSON.stringify(buf);
      if (buf.length && !buf.some(i => i.mediaPending || i.preparingAt)) {
        const chatId = buf[buf.length - 1].msg.chat?.id;
        const threadId = threadIdOf(buf[buf.length - 1].msg);
        const intent = coalescedIntent(buf);
        let verdict = { level: 'insufficient' };
        try {
          if (this.env.EXECUTION_BACKEND === 'control-plane') {
            verdict = { level: 'clear' };
          } else if (intent.trim()) {
            // Pass the chat identity so a short «продолжай» can be judged against
            // the assistant's last answer (agent #1823).
            const session = await this._gateSession(chatId, threadId);
            verdict = await checkCompleteness(this.env, { text: intent, username: session?.username || null, chatId, threadId });
          }
        } catch { /* Leave input intact and offer manual launch. */ }
        const current = await this._exclusive(async () => {
          if (JSON.stringify((await this.state.storage.get('buf')) || []) !== snapshot ||
              await this.state.storage.get('debounceExpiresAt') !== debounceExpiresAt ||
              await this.state.storage.get('busy') || await this.state.storage.get('stopped')) return false;
          await this.state.storage.delete('debounceExpiresAt');
          await this.state.storage.delete('gateLevel');
          return true;
        });
        if (!current) {
          // H1: the reservation lost the race (buffer changed / became busy /
          // stopped). The batch is still waiting — it must keep a timer.
          await this._ensureArmed(chatId);
          return;
        }
        if (verdict?.level === 'clear' || verdict?.level === 'likely' || verdict?.level === 'continue') {
          await this.state.storage.delete('gateErrAttempts');
          await this._dispatch(snapshot);
        } else if (verdict?.level === 'error' && chatId) {
          // The judge did not answer — NOT «your input is unclear» (#248). Keep the
          // batch and the timer alive: re-arm a short retry instead of going dark.
          const attempts = ((await this.state.storage.get('gateErrAttempts')) || 0) + 1;
          if (attempts < GATE_ERR_MAX_ATTEMPTS) {
            await this.state.storage.put('gateErrAttempts', attempts);
            await this.state.storage.put('gateLevel', 'error');
            const retryAt = Date.now() + GATE_ERR_RETRY_MS;
            await this.state.storage.put('debounceExpiresAt', retryAt);
            await this.state.storage.setAlarm(retryAt);
            await this._showCollector(chatId, buf.length, buf.at(-1).msg.message_id, threadIdOf(buf.at(-1).msg), gateRetryText(attempts));
          } else {
            // Budget spent: stop retrying, but never strand — the explicit
            // «нажми ▶️» text (and its button) is the way out.
            await this.state.storage.delete('gateErrAttempts');
            await this._showCollector(chatId, buf.length, buf.at(-1).msg.message_id, threadIdOf(buf.at(-1).msg), insufficientText);
            // H2: this branch has no debounce left, so the watchdog is the only
            // thing that can re-offer if that send did not land.
            await this._ensureArmed(chatId);
          }
        } else if (chatId) {
          await this._parkBatch(chatId, buf, threadIdOf(buf.at(-1).msg), insufficientText);
        }
        return;
      }
    }
    if (debounceExpiresAt && Date.now() < debounceExpiresAt) {
      const alarm = await this.state.storage.getAlarm();
      if (!alarm || alarm <= Date.now() || alarm > debounceExpiresAt) await this.state.storage.setAlarm(debounceExpiresAt);
      return;
    }
    // ── Parked batch re-offer (#248) ────────────────────────────────────────────
    // A batch the judge refused sits with no timer of its own. One visible reminder
    // after PARK_REOFFER_MS, then quiet — the batch itself is never dropped, it
    // waits for ▶️, a new message, or /clean_buffer. New input clears parkedAt
    // (_armAutoDispatch), so a still-set marker means the user has not replied.
    const parkedAt = await this.state.storage.get('parkedAt');
    if (parkedAt && !(await this.state.storage.get('busy')) && !(await this.state.storage.get('stopped'))
        && ((await this.state.storage.get('parkReoffers')) || 0) < 1
        && Date.now() - parkedAt >= PARK_REOFFER_MS) {
      const items = [...((await this.state.storage.get('retryBatch')) || []), ...((await this.state.storage.get('buf')) || [])];
      if (items.length) {
        const last = items.at(-1).msg;
        await this._showCollector(last.chat?.id, items.length, last.message_id, threadIdOf(last),
          parkReofferText(items.length), { fresh: true });
      }
      await this.state.storage.put('parkReoffers', 1);
      await this.state.storage.deleteAlarm();
      return;
    }
    // ── End debounce ────────────────────────────────────────────────────────────

    // Busy release (epic #1527 PR1): primary signal is the agent's
    // run-finished push; this branch is the per-minute safety net — poll the
    // agent's chat-scoped activity, and hard-cap at BUSY_MAX_MS. After any
    // release the collector below re-offers the launch button for held input.
    if ((await this.state.storage.get('busy')) === true) {
      if (this.env.EXECUTION_BACKEND === 'control-plane') {
        const released = await this._pollControlPlaneTasks();
        if (!released) await this._ensureAlarmBy(Date.now() + BUSY_POLL_MS);
        else if (receiptDue) await this._ensureAlarmBy(receiptDue);
        return;
      }
      const since = (await this.state.storage.get('busySince')) || 0;
      const age = Date.now() - since;
      if (age < BUSY_MAX_MS) {
        const released = age >= 30_000 && await this._pollRunFinishedIfIdle(since);
        if (!released) {
          await this.state.storage.setAlarm(Math.min(since + BUSY_MAX_MS, Date.now() + 60000));
          return;
        }
      } else {
        // Hard cap: a dispatched-but-never-reported batch becomes retryable
        // input again (original items were never acknowledged as run).
        await this._exclusive(async () => {
          const launching = (await this.state.storage.get('launching')) || [];
          if (launching.length) await this.state.storage.put('retryBatch', launching);
          await this._releaseBusyLocked();
        });
        await this._afterBusyRelease();
      }
    }
    const buf = [...((await this.state.storage.get('retryBatch')) || []), ...((await this.state.storage.get('buf')) || [])];
    if (buf.length) {
      const last = buf[buf.length - 1].msg;
      await this._showCollector(last.chat?.id, buf.length, last.message_id, threadIdOf(last));
    }
  }
}

function json(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { 'content-type': 'application/json' },
  });
}
