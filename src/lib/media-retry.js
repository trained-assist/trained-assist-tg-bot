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
      // agent VM restarts routinely (deploys land continuously — see PR history);
      // observed downtime per restart is ~1-3s. The old 2-attempt/1.5s budget was
      // shorter than a single restart blip, so any attachment upload racing a
      // deploy failed with "Не удалось подготовить вложение" for no real reason.
      if (!transient || attempt >= 3 || delay > 6000) throw error;
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
