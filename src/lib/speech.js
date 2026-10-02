// Единственный контракт распознавания речи в шлюзе (tg-bot#319).
//
// Раньше у боя были СВОИ вызовы Deepgram — три копии (media-jobs / transcribeVoice /
// debug-роут), свои ретраи, свой таймаут и свой ключ в env воркера. Теперь один путь:
//   байты → PUT /intake-files агента → path → POST /action → speech_transcribe (скил).
// У шлюза не остаётся ни ключа, ни адреса Deepgram: guard-тест в CI держит src/**
// свободным от api.deepgram.com, иначе копия отрастёт опять.
//
// Путь из PUT-ответа (`path`) — относительно рабочей папки профиля, в той же
// директории, где /action спавнит MCP-серверы. Его и подаём как `source`.
import { putIntakeFile } from './intake-files.js';
import { retryMedia, checkMediaResponse } from './media-retry.js';

// Стабильный id: /intake-files принимает 16..64 hex. Берём sha256 от детерминированного
// ключа, который передал вызывающий (иначе повтор попал бы в другой файл и ломал бы
// идемпотентность загрузки, на которую рассчитан media-jobs).
async function idFor(key) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Распознать аудио, которое уже есть у шлюза, либо байты, которые надо отдать агенту.
 *
 * @param env     bindings воркера (нужны AGENT_URL / AGENT_SECRET)
 * @param opts.username обязательный профиль — скил пишет лог и ключи по USER_ID
 * @param opts.fileRef  ссылка на файл, уже лежащий на агенте (есть путь → не грузим заново)
 * @param opts.bytes    байты для закачки (когда fileRef отсутствует)
 * @param opts.key      детерминированный ключ идентичности (ретраи кладут в тот же файл)
 * @param opts.name/mime тип файла — от него зависит определение формата скилом
 * @param opts.retry      повторять сбой транскрибации внутри вызова (см. ниже)
 * @returns { text, duration, language }
 * @throws  Error с признаком permanent/retryAfterMs — как и раньше, catch-блоки этих не меняют
 */
export async function transcribeAudio(env, { username, fileRef, bytes, key, name, mime, language, retry = false } = {}) {
  if (!username) throw Object.assign(new Error('Распознавание: не передан профиль'), { permanent: true });

  let source = fileRef?.path;
  if (!source) {
    if (!bytes) throw Object.assign(new Error('Распознавание: нет ни файла на агенте, ни байтов'), { permanent: true });
    if (!key) throw Object.assign(new Error('Распознавание: не передан ключ идентичности файла'), { permanent: true });
    const id = await idFor(key);
    // putIntakeFile — это upload() из intake-files.js: позиционные аргументы
    // (env, username, id, name, mime, body) и на выходе meta, а не строка.
    // Вызвать объектом нельзя: в URL уехали бы [object Object] и id=undefined,
    // а source остался бы объектом (поймано прогоном media-jobs).
    // Тот же retryMedia, что и вокруг остальных idempotent PUT /intake-files
    // (см. шапку media-retry.js): сеть на пути «закачать файл» обрывается не реже,
    // чем путь из Telegram, а повтор безопасен — id детерминирован.
    // Повтор закачки — тоже ровно тот, что был: storeTelegramFile оборачивал
    // upload в retryMedia, а прямые PUT из media-jobs в него не входили.
    const put = () => putIntakeFile(env, username, id, name || 'audio', mime || 'application/octet-stream', bytes);
    const meta = retry ? await retryMedia(put) : await put();
    if (!meta?.path) {
      // Агент старше trained-assist-agent#2052: path в ответе нет. Падаем явно,
      // а не молча уходим обратно в свой вызов Deepgram — шлюз такого пути больше
      // не содержит (см. tests/speech-contract.test.js).
      throw Object.assign(new Error('Агент не вернул путь файла — обнови агента до версии с path в /intake-files'), { permanent: true });
    }
    source = meta.path;
  }
  return transcribeViaAgent(env, { username, source, language, retry });
}

// Единственный контракт распознавания речи у шлюза (tg-bot#319): sibling-скил
// speech_transcribe, вызванный мостом POST /action агента. Свой запрос к Deepgram
// больше не отправляется (guard: в src/** не остаётся api.deepgram.com).
//
// Живёт здесь, а не в lib/agent-client.js, намеренно: 19 файлов тестов мокают
// адаптер целиком, и вынос речи в него означал бы «забыть transcribeViaAgent в
// vi.mock» в каждом новом тесте на голос. Здесь связка «файл → /action» неразделима.
//
// `retry` разделяет два ПРЕЖНИХ режима, а не добавляет третий:
//   - readMedia (transcribeVoice, путь preflight) повторял сбой сам, 5 раз;
//   - media-jobs звал fetch напрямую и полагался только на счётчик попыток ДО.
// Свойство «кто сколько раз повторяет» трогать нельзя: меняется и латентность
// прод-пути, и критерий тестов. Успех → { text, duration, language }. Иначе
// кидаем ошибку с признаком permanent/retryAfterMs — тот же словарь, на который
// рассчитан catch-блок MediaJob.
export async function transcribeViaAgent(env, { username, source, language = 'ru', retry = false }) {
  if (!env.AGENT_URL) throw Object.assign(new Error('Распознавание не настроено: не задан адрес агента'), { permanent: true });

  const call = async () => {
    const response = await fetch(`${env.AGENT_URL}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.AGENT_SECRET || ''}` },
      body: JSON.stringify({ username, tool: 'speech_transcribe', params: { source, language } }),
      signal: AbortSignal.timeout(120_000),
    });
    // Бросает со .status и .retryAfterMs — retryMedia сам решает, повторять ли.
    checkMediaResponse(response, 'Распознавание');
    return response;
  };
  // Там, где раньше стоял readMedia (path preflight), сохраняем его повторы;
  // там, где раньше был обычный fetch (media-jobs), оставляем один ход — у него
  // свой счётчик попыток в Durable Object.
  const res = retry ? await retryMedia(call) : await call();

  const data = await res.json().catch(() => null);
  const result = data?.result;
  if (!data?.ok || !result) throw Object.assign(new Error('Распознавание недоступно: пустой ответ агента'), { permanent: true });
  if (result.error) {
    // Ответ скила типизированный {error, hint}. Пустая запись — не сбой сервиса,
    // а результат (тишина/речь не найдена): повтор не поможет.
    throw Object.assign(new Error(result.hint || result.error), { permanent: true, toolError: result.error });
  }
  if (!result.text) throw Object.assign(new Error('Не удалось распознать речь'), { permanent: true });
  return { text: result.text, duration: result.duration ?? null, language: result.language ?? language };
}
