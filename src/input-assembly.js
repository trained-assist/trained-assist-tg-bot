// Shared by draft preview and the actual launch; no UI reconstruction.
// Token compressor: a transcribed voice/audio message carries its content as
// `m.transcript` — the raw media file is unusable by the model (no audio input on
// any engine). So instead of a redundant "Вложение 1: audio.ogg" line we emit a
// compact format marker and mark the raw ref `note:false` so the agent skips its
// "[Файл сохранён: .../audio.ogg]" note too (the file is still copied/pinned).
const MEDIA_MARKER = m => m.voice ? '[голосовое]' : m.audio ? '[аудио]' : m.video ? '[видео]' : null;

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
