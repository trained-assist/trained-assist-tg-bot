import { describe, it, expect, vi } from 'vitest';

const mock = vi.hoisted(() => ({ enqueue: vi.fn() }));

vi.mock('../src/sandbox-tg/config.js', async importOriginal => ({
  ...await importOriginal(),
  readTgSliceConfig: () => ({}),
}));
vi.mock('../src/sandbox-tg/delivery-owner.js', () => ({
  TgDeliveryOwnerClient: class {
    constructor() {}
    enqueue(value) { return mock.enqueue(value); }
  },
}));

import { publishRoutingDegradation } from '../src/lib/control-plane-execution.js';

describe('routing degradation user notice', () => {
  it('hides classifier and router internals when falling back to the executor', async () => {
    mock.enqueue.mockResolvedValue(undefined);
    await publishRoutingDegradation({}, { userTaskId: 'task-1', providerAcceptedAt: 123 },
      { degraded: true, continuation: { issued: true } }, { chatId: 42 }, 'conversation-1');

    expect(mock.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      text: 'Не удалось определить подходящий сценарий. Передаю задачу на проработку.',
    }));
  });

  it('does not claim that the executor started when continuation was not issued', async () => {
    mock.enqueue.mockResolvedValue(undefined);
    await publishRoutingDegradation({}, { userTaskId: 'task-2', providerAcceptedAt: 123 },
      { degraded: true, continuation: { issued: false } }, { chatId: 42 }, 'conversation-2');

    expect(mock.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      text: 'Не удалось определить подходящий сценарий. Задача сохранена, запуск исполнителя пока не подтверждён.',
    }));
  });
});
