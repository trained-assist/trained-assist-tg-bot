// Shared by draft preview and the actual launch; no UI reconstruction.
export function assembleInput(items, batch = true) {
  const prepared = items.map((item, index) => {
    const m = item.msg || {};
    const caption = (item.text || m.text || m.caption || '').split('\n')
      .filter(line => !/^(photo|voice|audio|document|video):/i.test(line.trim())).join('\n').trim();
    return { text: [caption, m.transcript, m.fileRef ? `Вложение ${index + 1}: ${m.fileRef.name}` : ''].filter(Boolean).join('\n'),
      refs: [m.fileRef, m.transcriptRef].filter(Boolean), isVoice: !!m.transcript };
  });
  return { task: batch ? prepared.map((p, i) => `[Сообщение ${i + 1}]\n${p.text}`).join('\n\n') : prepared[0]?.text || '',
    fileRefs: prepared.flatMap(p => p.refs), isVoice: prepared.some(p => p.isVoice) };
}
