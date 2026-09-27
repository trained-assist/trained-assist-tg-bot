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

// Compact inspection document for the «Посмотреть input» file. Shows the
// assembled task as-is (what the gateway sent the model) plus a truthful note
// that the model's FULL input is much larger: it also carries the system
// prompt (role/persona, project rules, answer-mode block), the MCP tool
// definitions and the context sections (agent notes, requirements log, session
// history). Those are assembled agent-side at run time and are identical
// boilerplate for every run of the profile — so they are not repeated here,
// but the user must not be left believing the 1-sentence task is all the model
// sees (2026-09-26: the report footer «вход N токенов» is the TOTAL input,
// task included; the old doc silently equated the task with the whole input).
export function renderSnapshotDocument(input, heading) {
  const task = input.body?.task ?? input.task ?? '';
  const lines = [heading, '',
    'Это только текст задачи — как он ушёл из шлюза в модель.',
    '',
    'Модель получает сверх этого текста:',
    '• системный промпт — роль/персона, правила, режим ответа',
    '• определения MCP-инструментов (все подключённые тулзы)',
    '• контекстные секции и историю сессии',
    '',
    'Поэтому «вход N токенов» в отчёте запуска — это ВЕСЬ вход модели, а не только этот текст.',
    '',
    '────────── Текст задачи (как ушёл модели) ──────────',
    task];
  const files = [];
  const seen = new Set();
  for (const ref of input.body?.fileRefs || []) {
    const key = ref.id || ref.name;
    if (!seen.has(key)) { seen.add(key); files.push(ref.name || ref.id); }
  }
  if (files.length) lines.push('', `Файлы: ${files.join(', ')}`);
  return lines.join('\n');
}
