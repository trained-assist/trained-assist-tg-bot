// Only receipt-backed CP snapshots are publishable. Draft text is never a fallback.
export async function publishAgentInputDocuments(client, outbox, intent) {
  const { value } = await client.request('GET', '/agent-inputs', { query: { taskId: intent.userTaskId }, signal: AbortSignal.timeout(5000) });
  if (value?.taskId !== intent.userTaskId || !Array.isArray(value.inputs)) throw new Error('agent_input_scope_mismatch');
  for (const input of value.inputs) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(input?.runId ?? '') || !Number.isSafeInteger(input.generation) || input.generation < 1
        || input.artifact?.ref !== `cp-agent-input:${input.runId}`) throw new Error('agent_input_scope_mismatch');
    const deliveryId = `agent-input:${input.runId}:g${input.generation}`;
    const queued = await outbox.enqueue({ deliveryId, taskAcceptedAt: intent.taskAcceptedAt,
      conversationId: intent.conversationId, userTaskId: intent.userTaskId, destination: intent.destination,
      requestId: deliveryId, type: 'input-document', artifact: input.artifact,
      text: `📋 Ввод принят на запуск. В документе — задача, инструкции и ссылки на вложения. Попытка ${input.generation}.` });
    if (queued?.record?.deliveryId !== deliveryId || queued.record.status === 'quarantined') throw new Error('agent_input_delivery_refused');
  }
}
