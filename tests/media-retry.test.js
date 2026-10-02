import { afterEach, expect, it, vi } from 'vitest';
import { readMedia } from '../src/lib/media-retry.js';
import { storeTelegramFile } from '../src/lib/intake-files.js';
import { transcribeVoice } from '../src/handlers/message.js';
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const json = data => new Response(JSON.stringify(data));
const env = { BOT_TOKEN: 'test', AGENT_URL: 'https://agent', AGENT_SECRET: 'test' };
it('retries an interrupted response body with a fresh timeout', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: () => Promise.reject(new TypeError('connection closed')) }).mockResolvedValueOnce(json({ ok: true }));
  vi.stubGlobal('fetch', fetcher);
  const result = readMedia('https://test');
  await vi.runAllTimersAsync();
  expect(await result).toEqual({ ok: true });
  expect(fetcher.mock.calls[0][1].signal).not.toBe(fetcher.mock.calls[1][1].signal);
});
it.each([400, 401, 403, 413])('does not retry permanent HTTP %s', async status => {
  const fetcher = vi.fn().mockResolvedValue(new Response('', { status }));
  vi.stubGlobal('fetch', fetcher);
  await expect(readMedia('https://test')).rejects.toMatchObject({ status });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('bounds transient failures to five attempts', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockImplementation(async () => new Response('', { status: 503 }));
  vi.stubGlobal('fetch', fetcher);
  const result = expect(readMedia('https://test')).rejects.toMatchObject({ status: 503 });
  await vi.runAllTimersAsync(); await result;
  expect(fetcher).toHaveBeenCalledTimes(5);
});
it('honors Retry-After', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '2' } })).mockResolvedValueOnce(json({ ok: true }));
  vi.stubGlobal('fetch', fetcher);
  const result = readMedia('https://test');
  await vi.advanceTimersByTimeAsync(1999); expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(await result).toEqual({ ok: true });
});
it('re-downloads consumed streams and preserves upload identity on retry', async () => {
  vi.useFakeTimers();
  const uploads = []; let downloads = 0;
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    if (url.includes('/getFile')) return json({ ok: true, result: { file_path: 'voice.ogg' } });
    if (url.includes('/file/bot')) { downloads++; return new Response('voice bytes'); }
    const id = new URL(url).searchParams.get('id');
    uploads.push({ id, body: await new Response(init.body).text() });
    if (uploads.length === 1) return new Response('', { status: 502 });
    return json({ id, size: 11 });
  }));
  // crypto.digest uses native async work, so start real timers until the first upload.
  vi.useRealTimers();
  const ref = await storeTelegramFile({ chat: { id: 1 }, message_id: 2 }, { file_id: 'voice' }, env, { username: 'test' });
  expect(downloads).toBe(2); expect(uploads[0]).toEqual(uploads[1]); expect(ref.id).toBe(uploads[0].id);
});
// ЗАМЕНА устаревшего теста с тем же названием (путь правил владелец: указать замену и причину).
// Причина: тест описывал ретраи НАПРЯМУЮ к Deepgram, а Ф4 (trained-assist-tg-bot#319)
// убрал прямой вызов — распознавание идёт PUT /intake-files → POST /action агента.
// Изменился способ (транспорт), требование НЕ изменилось: сбой транскрибации
// повторяется, аудио не скачивается второй раз.
it('retries transcription without re-downloading audio (через POST /action)', async () => {
  // Настоящие таймеры и потолок 10 с: у retryMedia настоящий backoff (500 мс на сбой).
  // Под фейковыми таймерами промис закачки ставит свой таймер ДО того, как
  // runAllTimersAsync успевает увидеть очередь, и тест виснет до 5-секундного
  // лимита — поведение-то самое обычное, таймеры здесь не предмет проверки.
  let downloads = 0, uploads = 0, actions = 0;
  const fetcher = vi.fn(async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/getFile')) return json({ ok: true, result: { file_path: 'voice.ogg' } });
    if (u.includes('/file/bot')) { downloads++; return new Response('audio'); }
    if (u.includes('/intake-files') && opts.method === 'PUT') {
      uploads++;
      const id = new URL(u).searchParams.get('id');
      if (uploads === 1) return new Response('', { status: 503 }); // закачка тоже повторяется
      return json({ id, name: 'voice.ogg', mime: 'audio/ogg', size: 5, path: `media/intake-store/${id}/data` });
    }
    if (u.endsWith('/action')) {
      actions++;
      if (actions === 1) return new Response('', { status: 503 }); // транскрибация тоже повторяется
      return json({ ok: true, result: { text: 'hello', duration: 1, language: 'ru' } });
    }
    throw new Error('unexpected fetch ' + u);
  });
  vi.stubGlobal('fetch', fetcher);
  // Профиль обязателен с Ф4: /action работает от USER_ID.
  const result = transcribeVoice('voice', null, env, { username: 'test' });
  expect(await result).toEqual({ transcript: 'hello', error: null });
  expect(downloads).toBe(1);   // аудио качается ровно один раз
  expect(actions).toBe(2);     // транскрибация повторилась после 503
}, 10000);
it('same media in different buffered messages has independent retention identity', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    if (url.includes('/getFile')) return json({ ok: true, result: { file_path: 'same.pdf' } });
    if (url.includes('/file/bot')) return new Response('same bytes');
    return json({ id: new URL(url).searchParams.get('id'), size: 10 });
  }));
  const file = { file_id: 'same', file_unique_id: 'same-unique' };
  const first = await storeTelegramFile({ chat: { id: 1 }, message_id: 2 }, file, env, { username: 'test' });
  const second = await storeTelegramFile({ chat: { id: 1 }, message_id: 3 }, file, env, { username: 'test' });
  const otherChat = await storeTelegramFile({ chat: { id: 2 }, message_id: 2 }, file, env, { username: 'test' });
  const retry = await storeTelegramFile({ chat: { id: 1 }, message_id: 2 }, file, env, { username: 'test' });
  expect(new Set([first.id, second.id, otherChat.id]).size).toBe(3);
  expect(retry.id).toBe(first.id);
});
