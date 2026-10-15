import { describe, expect, it, vi } from 'vitest';
import { publishAgentInputDocuments } from '../src/lib/agent-input-document.js';

const intent = { userTaskId: 'task-1', taskAcceptedAt: 1700000000000, conversationId: 'conversation-1',
  destination: { chatId: 42, threadId: 7 } };
const snapshot = { runId: 'run_123', generation: 1,
  artifact: { ref: 'cp-agent-input:run_123', name: 'agent-input-g1-run_123.json', sizeBytes: 42,
    sha256: 'a'.repeat(64), contentType: 'application/json' } };
const response = inputs => ({ value: { taskId: intent.userTaskId, inputs } });

function fixture(inputs = [snapshot]) {
  const records = new Map();
  const client = { request: vi.fn(async () => response(inputs)) };
  const outbox = { enqueue: vi.fn(async record => {
    if (!records.has(record.deliveryId)) records.set(record.deliveryId, { ...record, status: 'pending' });
    return { record: records.get(record.deliveryId) };
  }) };
  return { client, outbox, records };
}

describe('accepted agent input publication', () => {
  it('sends no document for unstarted and quick-answer tasks', async () => {
    const { client, outbox } = fixture([]);
    await publishAgentInputDocuments(client, outbox, intent);
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('publishes to the frozen original chat/topic with stable per-attempt identity', async () => {
    const { client, outbox, records } = fixture();
    await publishAgentInputDocuments(client, outbox, intent);
    await publishAgentInputDocuments(client, outbox, intent);
    expect(records.size).toBe(1);
    expect([...records.values()][0]).toMatchObject({ type: 'input-document', destination: intent.destination,
      userTaskId: intent.userTaskId, artifact: snapshot.artifact,
      deliveryId: 'agent-input:run_123:g1', taskAcceptedAt: intent.taskAcceptedAt });
    expect(client.request).toHaveBeenCalledWith('GET', '/agent-inputs', { query: { taskId: intent.userTaskId }, signal: expect.any(AbortSignal) });
  });

  it('retains separate documents for new attempts and parallel tasks', async () => {
    const { client, outbox, records } = fixture([snapshot, { ...snapshot, runId: 'run_456', generation: 2,
      artifact: { ...snapshot.artifact, ref: 'cp-agent-input:run_456' } }]);
    await publishAgentInputDocuments(client, outbox, intent);
    expect(records.size).toBe(2);
  });

  it.each([
    { taskId: 'other-task', inputs: [snapshot] },
    { taskId: intent.userTaskId, inputs: [{ ...snapshot, artifact: { ...snapshot.artifact, ref: 'foreign' } }] },
    { taskId: intent.userTaskId, inputs: [{ ...snapshot, generation: 0 }] },
  ])('rejects mismatched source evidence', async value => {
    const { client, outbox } = fixture();
    client.request.mockResolvedValue({ value });
    await expect(publishAgentInputDocuments(client, outbox, intent)).rejects.toThrow('agent_input_scope_mismatch');
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('does not fall back to local text when CP is unavailable', async () => {
    const { client, outbox } = fixture();
    client.request.mockRejectedValue(new Error('unavailable'));
    await expect(publishAgentInputDocuments(client, outbox, intent)).rejects.toThrow('unavailable');
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });
});
