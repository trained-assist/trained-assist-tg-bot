// Shared by draft preview and the actual launch; no UI reconstruction.
// Token compressor: a transcribed voice/audio message carries its content as
// `m.transcript` — the raw media file is unusable by the model (no audio input on
// any engine). So instead of a redundant "Вложение 1: audio.ogg" line we emit a
// compact format marker and mark the raw ref `note:false` so the agent skips its
// "[Файл сохранён: .../audio.ogg]" note too (the file is still copied/pinned).
const MEDIA_MARKER = m => m.voice ? '[голосовое]' : m.audio ? '[аудио]' : m.video ? '[видео]' : null;

// taskId the agent assigns to this dispatched run — mirrors the agent's /run
// derivation (`${requestOwner}-${requestId}`, owner = audience-scoped username;
// server.js requestOwner). Null when the snapshot can't yield a valid id → the
// caller keeps its own gateway-side view instead of asking the agent.
export function runInputTaskId(body) {
  const requestId = body?.requestId;
  const username = body?.username;
  if (!requestId || !/^[a-zA-Z0-9_-]{1,128}$/.test(requestId)) return null;
  if (!username || !/^[a-zA-Z0-9_-]{1,32}$/.test(username)) return null;
  const audience = body?.audience;
  const owner = audience && audience !== 'default' ? `${username}-${audience}` : username;
  return `${owner}-${requestId}`;
}

export function assembleInput(items, batch = true) {
  const prepared = items.map((item, index) => {
    const m = item.msg || {};
    const caption = (item.text || m.text || m.caption || '').split('\n')
      .filter(line => !/^(photo|voice|audio|document|video):/i.test(line.trim())).join('\n').trim();
    const marker = MEDIA_MARKER(m);
    const attachLine = m.transcript && marker
      ? marker
      : (m.fileRef ? `Вложение ${index + 1}: ${m.fileRef.name}` : '');
    const fileRef = (m.transcript && marker && m.fileRef) ? { ...m.fileRef, note: false } : m.fileRef;
    return { text: [caption, m.transcript, attachLine].filter(Boolean).join('\n'),
      refs: [fileRef, m.transcriptRef].filter(Boolean), isVoice: !!m.transcript };
  });
  return { task: batch ? prepared.map((p, i) => `[Сообщение ${i + 1}]\n${p.text}`).join('\n\n') : prepared[0]?.text || '',
    fileRefs: prepared.flatMap(p => p.refs), isVoice: prepared.some(p => p.isVoice) };
}

// «Посмотреть input» document when the agent's real input is unavailable
// (not launched yet, or an old run). The file IS the task text exactly as the
// gateway sends it — nothing else: no heading, no «модель получает сверх…»
// explanations, no file list (owner 29.09: commentary inside the input file
// hides the input; the doc must be as-is). Context lives in the Telegram
// caption, never in the file. After launch the button returns the agent's
// real input (system prompt + task, fetchRunInput) instead of this.
export function renderSnapshotDocument(input) {
  return input.body?.task ?? input.task ?? '';
}
