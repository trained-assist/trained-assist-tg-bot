export function stopReplyConfirmsRequest(text) {
  const message = String(text ?? '');
  return /останов|stopp/i.test(message)
    && !/не подтвержден|не удалось подтвердить|исход неизвестен|not confirmed|unknown outcome/i.test(message);
}
