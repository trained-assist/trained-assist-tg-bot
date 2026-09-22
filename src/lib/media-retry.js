// Only media reads, transcription and idempotent file PUTs belong here.
// Never wrap /run or Telegram message delivery.
export function checkMediaResponse(response, label) {
  if (response.ok) return;
  const error = new Error(`${label}: HTTP ${response.status}`);
  error.status = response.status;
  const seconds = Number(response.headers?.get('retry-after'));
  if (seconds > 0) error.retryAfterMs = seconds * 1000;
  void response.body?.cancel().catch(() => {});
  throw error;
}

export async function retryMedia(operation) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      const transient = error.status === 408 || error.status === 429
        || error.status >= 500 && error.status <= 599
        || ['TypeError', 'AbortError', 'TimeoutError'].includes(error.name);
      const delay = error.retryAfterMs || 500 * 2 ** attempt;
      // Do not ignore a long Retry-After or occupy the launch indefinitely. The
      // agent VM restarts far more often than "routine deploy blips" suggested —
      // journalctl shows restarts as close as ~60-90s apart during active
      // development, sometimes in quick pairs. Each restart's downtime is short
      // (~2s), but the 3-attempt/3.5s budget left too little margin: back-to-back
      // restarts or a slightly slower reboot still exhausted it before the VM
      // came back, reproducing "Не удалось подготовить вложение" even after the
      // first widening (see PR #191). Give it real headroom instead of chasing
      // the exact restart cadence.
      if (!transient || attempt >= 4 || delay > 9000) throw error;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

export function readMedia(url, init = {}, type = 'json', timeoutMs = 20000) {
  return retryMedia(async () => {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    checkMediaResponse(response, 'Media');
    return response[type]();
  });
}
