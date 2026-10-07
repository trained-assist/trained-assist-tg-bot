import { releaseBufferPins } from './lib/intake-files.js';
import { applyTestDelivery, isTestChat, suppress } from './lib/test-mode.js';
import { logError, logWarn } from './log.js';
import { resolveErrorPublisher, buildErrorEvent } from './error-publisher.js';
const AGENT_DOWN_NOTICE_MS = 30_000;
// One durable outbox per profile/chat. Alarms retry until the agent acknowledges
// the stable requestId. Files are chunked below DO's per-value storage limit.
export class RunOutbox {
  constructor(state, env) { this.state = state; this.env = env; }
  async fetch(request) {
    return this.state.blockConcurrencyWhile(async () => {
      const path = new URL(request.url).pathname;
      // User-initiated stop (INV-08 / SS-05): drop every queued delivery for this
      // chat so it cannot self-launch after the user stopped it. A tombstone is
      // kept per requestId so a later re-enqueue of the same id cannot resurrect
      // the job. blockConcurrencyWhile makes this atomic against an in-flight alarm.
      if (path === '/cancel') {
        const { chatId, threadId = null } = await request.json();
        const jobs = [...(await this.state.storage.list({ prefix: 'job:' }))];
        let cancelled = 0;
        await this.state.storage.transaction(async txn => {
          for (const [key, job] of jobs) {
            if (String(job.chatId) !== String(chatId)) continue;
            if (threadId != null && String(job.threadId ?? '') !== String(threadId)) continue;
            await txn.put(`cancelled:${job.id}`, { at: Date.now(), chatId: job.chatId, threadId: job.threadId ?? null });
            await txn.delete(key);
            for (let i = 0; i < job.chunks; i++) await txn.delete(`${job.id}:${i}`);
            cancelled++;
          }
        });
        return Response.json({ cancelled });
      }
      const { agentUrl, body } = await request.json();
      const id = body.requestId;
      if (!id || agentUrl !== this.env.AGENT_URL) return Response.json({ error: 'invalid delivery' }, { status: 400 });
      const key = `job:${id}`;
      if (!await this.state.storage.get(key) && !await this.state.storage.get(`done:${id}`) && !await this.state.storage.get(`failed:${id}`) && !await this.state.storage.get(`cancelled:${id}`)) {
        const data = JSON.stringify(body);
        if (new TextEncoder().encode(data).length > 32 * 1024 * 1024) return Response.json({ error: 'payload exceeds 32 MiB' }, { status: 413 });
        const chunks = Math.ceil(data.length / 32000);
        await this.state.storage.transaction(async txn => {
          for (let i = 0; i < chunks; i++) await txn.put(`${id}:${i}`, data.slice(i * 32000, (i + 1) * 32000));
          const sequence = (await txn.get('sequence') || 0) + 1;
          await txn.put('sequence', sequence);
          await txn.put(key, { id, agentUrl, chunks, sequence, createdAt: Date.now(), chatId: body.userId, threadId: body.threadId || null, initialMsgId: body.initialMsgId });
          await txn.setAlarm(Date.now() + 1000);
        });
      }
      // Acknowledge durable storage, not execution. Alarm owns all delivery so
      // concurrent /run requests cannot overtake a failed preceding request.
      return Response.json({ taskId: id, queued: true, outbox: true }, { status: 202 });
    });
  }
  async alarm() {
    return this.state.blockConcurrencyWhile(async () => {
      // Arm BEFORE I/O: a crash between acceptance and delete remains recoverable.
      await this.state.storage.setAlarm(Date.now() + 15000);
      const jobs = [...(await this.state.storage.list({ prefix: 'job:' })).values()]
        .sort((a, b) => a.sequence - b.sequence);
      // One delivery per alarm bounds the concurrency block below the platform
      // 30-second limit, including the 10s HTTP timeout and 5s notification.
      for (const job of jobs.slice(0, 1)) {
        let data = '';
        for (let i = 0; i < job.chunks; i++) {
          const chunk = await this.state.storage.get(`${job.id}:${i}`);
          if (typeof chunk !== 'string') throw Error('Outbox payload incomplete; retained for recovery');
          data += chunk;
        }
        try {
          // Negotiate BEFORE sending work: a legacy agent executes /run but cannot
          // deduplicate a lost ACK. Retrying against it would create duplicate jobs.
          const capability = await fetch(`${job.agentUrl}/maintenance`, {
            headers: { Authorization: `Bearer ${this.env.AGENT_SECRET}` },
            signal: AbortSignal.timeout(5000),
          });
          if (!capability.ok || (await capability.json()).durableIngress !== 1) throw Error('Durable ingress is not ready');
          // Test mode, last hop before POST /run (DESIGN §2.1): flag + reserve
          // id in ONE branch; job.chatId stays REAL (used by notify/release above).
          try {
            const parsed = JSON.parse(data);
            if (applyTestDelivery(this.env, parsed)) data = JSON.stringify(parsed);
          } catch { /* keep the original payload */ }
          const res = await fetch(`${job.agentUrl}/run`, {
            method: 'POST', headers: { Authorization: `Bearer ${this.env.AGENT_SECRET}`, 'Content-Type': 'application/json' },
            body: data, signal: AbortSignal.timeout(10000),
          });
          if (!res.ok) {
            if ([400, 413, 422].includes(res.status)) {
              // Keep failed payloads for repair, but don't poison every following job.
              await this.state.storage.put(`failed:${job.id}`, { ...job, status: res.status });
              const failure = { code: 'OUTBOX_REJECTED', operation: 'deliver', message: `agent rejected delivery HTTP ${res.status}`, chatId: job.chatId, requestId: job.id };
              logError(failure);
              resolveErrorPublisher(this.env)?.(buildErrorEvent({ ...failure, traceId: job.id }));
              await this.notify(job, `⚠️ Задача сохранена, но сервер отклонил её (HTTP ${res.status}). Нужна проверка; автоматически повторять её не буду.`);
              await this.state.storage.delete(`job:${job.id}`);
              // Epic #1527 PR1: the agent will never send run-finished for a
              // rejected job — release the chat's busy hold now or it sticks
              // until BUSY_MAX_MS (match by this job's requestId).
              await this.releaseIntakeBusy(job);
              continue;
            }
            throw Error(`HTTP ${res.status}`);
          }
          // Require valid acknowledgement; a proxy's HTML 200 isn't acceptance.
          const ack = await res.json();
          if (!ack.durable || ack.requestId !== job.id || !ack.taskId) throw Error('No matching durable acknowledgement');
          const accepted=JSON.parse(data);
          await releaseBufferPins(this.env,accepted.username,accepted.fileRefs);
          if(job.agentUrl!==this.env.AGENT_URL)await releaseBufferPins(this.env,accepted.username,accepted.fileRefs,job.agentUrl);
          await this.state.storage.transaction(async txn => {
            await txn.put(`done:${job.id}`, { taskId: ack.taskId });
            await txn.delete(`job:${job.id}`);
            for (let i = 0; i < job.chunks; i++) await txn.delete(`${job.id}:${i}`);
          });
        } catch (e) {
          // A restart takes ~2 s and the alarm retries every 15 s: stay silent through short blips and
          // tell the user only when the agent has been unreachable for a while.
          const firstFailAt = job.firstFailAt || Date.now();
          const down = Date.now() - firstFailAt >= AGENT_DOWN_NOTICE_MS;
          if (down && !job.notified) {
            const failure = { code: 'OUTBOX_TRANSPORT_FAILED', operation: 'deliver', message: e.message, chatId: job.chatId, requestId: job.id, failedMs: Date.now() - firstFailAt };
            logWarn(failure);
            resolveErrorPublisher(this.env)?.(buildErrorEvent({ ...failure, traceId: job.id }));
          }
          if (!job.firstFailAt || (down && !job.notified)) {
            if (down) await this.notify(job, '⚠️ Сервер недоступен дольше обычного. Задача не потеряна — отправлю автоматически, когда он вернётся. Пока можешь писать в чат: следующее сообщение уйдёт отдельной задачей.');
            await this.state.storage.put(`job:${job.id}`, { ...job, firstFailAt, ...(down ? { notified: true } : {}) });
          }
          // The chat must not stay locked behind a job we cannot deliver. The outbox
          // KEEPS retrying (the payload is preserved and still goes out later), but the
          // busy hold in the intake DO is released once the user has been told — otherwise
          // an undeliverable job pins the chat until BUSY_MAX_MS (45 min), which is the
          // 2026-10-04 incident: chat -5111318625 held 33 min with six messages inside
          // and no run. Releasing loses nothing: the batch was already consumed by this
          // dispatch, so there is nothing left to re-dispatch twice; and when the job is
          // finally delivered the agent's own run-finished arrives as usual.
          if (down && !job.holdReleased) {
            await this.releaseIntakeBusy(job);
            await this.state.storage.put(`job:${job.id}`, { ...job, firstFailAt, notified: true, holdReleased: true });
          }
          return; // preserve FIFO on transient errors
        }
      }
      if (!(await this.state.storage.list({ prefix: 'job:', limit: 1 })).size) await this.state.storage.deleteAlarm();
      else await this.state.storage.setAlarm(Date.now() + 100); // next FIFO item, bounded invocation
    });
  }
  async notify(job, text) {
    // Test mode: job.chatId is the REAL id (never swapped) — gate it here.
    if (isTestChat(this.env, job.chatId)) { suppress(job.chatId, 'notify', text); return; }
    const method = job.initialMsgId ? 'editMessageText' : 'sendMessage';
    try {
      await fetch(`https://api.telegram.org/bot${this.env.BOT_TOKEN}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: job.chatId, ...(job.initialMsgId ? { message_id: job.initialMsgId } : (job.threadId ? { message_thread_id: job.threadId } : {})), text }),
        signal: AbortSignal.timeout(5000),
      });
    } catch { /* Delivery status must not remove the queued payload. */ }
  }
  // Epic #1527 PR1: permanent delivery failure means no run-finished push will
  // ever arrive for this dispatch — tell the chat's IntakeBuffer to release its
  // busy hold (matched by requestId) instead of waiting for BUSY_MAX_MS.
  async releaseIntakeBusy(job) {
    try {
      const { conversationKey } = await import('./conversation-context.js');
      const stub = this.env.INTAKE.get(this.env.INTAKE.idFromName(conversationKey(job.chatId, job.threadId || null)));
      await stub.fetch('https://intake/run-finished', {
        method: 'POST',
        body: JSON.stringify({ requestId: job.id }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (e) {
      console.warn('[outbox] release busy failed:', e.message);
    }
  }
}
