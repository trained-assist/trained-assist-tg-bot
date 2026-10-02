import { vi } from 'vitest';

// Стаб воркера в тестах: модель агента ровно в том объёме, который использует
// контракт распознавания речи (Ф4, trained-assist-tg-bot#319).
//
//   PUT /intake-files  → агент принял байты и вернул meta, в т.ч. `path`
//                         (путь относительно рабочей папки профиля — trained-assist-agent#2052;
//                          раньше его не было, и тесты падали на «не подтвердил сохранение»)
//   POST /action       → скил speech_transcribe вернул { text, duration, language }
//                         либо типизированную ошибку { error, hint }
//
// Тесты описывают транскрипцию через `delegate` по-старому — ключом на адрес Deepgram.
// Он остаётся рабочим: стаб подставляет этот адрес вместо /action и оборачивает ответ
// в форму агента. Ничего переписывать в существующих тестах не пришлось — меняется
// только то, что стаб делает на проводе.
export function withUploads(delegate, options = {}) {
  return vi.fn(async (url, opts = {}) => {
    const target = String(url);

    if (target.includes('/intake-files?') && opts.method === 'PUT') {
      const query = new URL(target.replace('undefined/', 'https://agent.test/')).searchParams;
      const bytes = await new Response(opts.body).arrayBuffer();
      const id = query.get('id');
      return Response.json({
        id,
        name: query.get('name'),
        mime: opts.headers['Content-Type'],
        size: bytes.byteLength,
        // Контракт trained-assist-agent#2052: путь, по которому скил сам прочитает файл.
        path: `media/intake-store/${id}/data`,
      });
    }

    if (target.endsWith('/action')) {
      const request = JSON.parse(opts.body);
      if (request.tool !== 'speech_transcribe') {
        return Response.json({ ok: false, error: `Unknown tool ${request.tool}` }, { status: 404 });
      }
      // Транскрипцию тесты описывают по адресу Deepgram — подставляем его, чтобы
      // существующие стабы продолжали описывать смысл, а не транспорт.
      const deepgram = await delegate('https://api.deepgram.com/v1/listen', opts);
      let text = options.text;
      if (text === undefined) {
        let payload = null;
        try { payload = await deepgram.clone().json(); } catch { payload = null; }
        text = payload?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
      }
      if (!text) {
        return Response.json({ ok: true, result: { error: 'audio_empty', hint: 'Deepgram вернул пустой текст.' } });
      }
      return Response.json({ ok: true, result: { text, duration: options.duration ?? 1, language: 'ru' } });
    }

    return delegate(url, opts);
  });
}
