import { describe, expect, it } from 'vitest';
import { stopReplyConfirmsRequest } from '../tools/sandbox3-stop-confirmation.mjs';

describe('sandbox3 stop confirmation text', () => {
  it.each(['⛔ Остановлено. 1 ждут — ▶️', '🛑 Задача остановлена.', 'Task stopped.'])('%s is a positive stop reply', text => {
    expect(stopReplyConfirmsRequest(text)).toBe(true);
  });

  it.each(['Не удалось подтвердить остановку. Исход неизвестен.', 'Stop not confirmed; unknown outcome.'])('%s is not confirmation', text => {
    expect(stopReplyConfirmsRequest(text)).toBe(false);
  });

  it('rejects a message with no stop wording', () => {
    expect(stopReplyConfirmsRequest('Готово')).toBe(false);
  });
});
