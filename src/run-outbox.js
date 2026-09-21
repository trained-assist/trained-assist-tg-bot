import { releaseBufferPins } from './lib/intake-files.js';
// One durable outbox per profile/chat. Alarms retry until the agent acknowledges
// the stable requestId. Files are chunked below DO's per-value storage limit.
export class RunOutbox {
  constructor(state, env) { this.state = state; this.env = env; }
  async fetch(request) {
    return this.state.blockConcurrencyWhile(async () => {
      const { agentUrl, body } = await request.json();
      const id = body.requestId;
      if (!id || ![this.env.AGENT_URL, this.env.AGENT_RU_URL].includes(agentUrl)) return Response.json({ error: 'invalid delivery' }, { status: 400 });
      const key = `job:${id}`;
      if (!await this.state.storage.get(key) && !await this.state.storage.get(`done:${id}`) && !await this.state.storage.get(`failed:${id}`)) {
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
          const res = await fetch(`${job.agentUrl}/run`, {
            method: 'POST', headers: { Authorization: `Bearer ${this.env.AGENT_SECRET}`, 'Content-Type': 'application/json' },
            body: data, signal: AbortSignal.timeout(10000),
          });
          if (!res.ok) {
            if ([400, 413, 422].includes(res.status)) {
              // Keep failed payloads for repair, but don't poison every following job.
              await this.state.storage.put(`failed:${job.id}`, { ...job, status: res.status });
              await this.notify(job, `⚠️ Задача сохранена, но сервер отклонил её (HTTP ${res.status}). Нужна проверка; автоматически повторять её не буду.`);
              await this.state.storage.delete(`job:${job.id}`);
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
          if (!job.notified) {
            await this.notify(job, '⏸ Задача сохранена. Сервер временно недоступен; передам её автоматически после восстановления.');
            await this.state.storage.put(`job:${job.id}`, { ...job, notified: true });
          }
          return; // preserve FIFO on transient errors
        }
      }
      if (!(await this.state.storage.list({ prefix: 'job:', limit: 1 })).size) await this.state.storage.deleteAlarm();
      else await this.state.storage.setAlarm(Date.now() + 100); // next FIFO item, bounded invocation
    });
  }
  async notify(job, text) {
    const method = job.initialMsgId ? 'editMessageText' : 'sendMessage';
    try {
      await fetch(`https://api.telegram.org/bot${this.env.BOT_TOKEN}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: job.chatId, ...(job.initialMsgId ? { message_id: job.initialMsgId } : (job.threadId ? { message_thread_id: job.threadId } : {})), text }),
        signal: AbortSignal.timeout(5000),
      });
    } catch { /* Delivery status must not remove the queued payload. */ }
  }
}
