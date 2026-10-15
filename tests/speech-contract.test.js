import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// У production CP intake один прямой клиент Deepgram. Старый agent backend
// продолжает использовать sibling-скил speech_transcribe через POST /action.
//
// До #319 у боя были три копии прямых вызовов Deepgram (media-jobs / transcribeVoice /
// debug-роут): свой ключ в env воркера, свои ретраи, свой таймаут, своё определение
// формата. Каждая копия жила своим жизнью и ломалась по-своему. Этот тест — та самая
// «дыра в классе»: убрать одну копию недостаточно, если ничто не мешает вернуть её.
//
// Новые прямые клиенты или дополнительные чтения ключа возвращают прежнюю
// проблему расхождения ретраев и форматов, поэтому они запрещены.

const SRC = new URL('../src', import.meta.url).pathname;

function walk(dir) {
  return readdirSync(dir).flatMap(name => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.js') ? [full] : [];
  });
}

const files = walk(SRC);
// Строки-комментарии выкидываем ДО проверки: описание контракта обязано называть и
// адрес, и имя ключа, иначе он не объясняет, чего нельзя делать. Ловить на комментариях —
// false positive, который заставляет писать «api . deepgram . com» кракозябрами
// (ровно так поймал ratchet-гейт на AGENT_BOT_TOKEN в agent#2050).
const code = f => readFileSync(f, 'utf8')
  .split('\n')
  .filter(line => !line.trim().startsWith('//'))
  .join('\n');

describe('контракт распознавания речи', () => {
  it('Deepgram вызывается только из единого клиента CP media intake', () => {
    const callers = files.filter(f => /api\.deepgram\.com/.test(code(f))).map(f => f.split('/src/')[1]);
    expect(callers).toEqual(['sandbox-tg/media-intake.js']);
  });

  it('ключ Deepgram читается только при подготовке CP intake', () => {
    const offenders = files.filter(f => /DEEPGRAM_API_KEY/.test(code(f))).map(f => f.split('/src/')[1]);
    expect(offenders,
      `Найдено дополнительное чтение Deepgram key: ${offenders.join(', ')}`)
      .toEqual(['intake-preflight.js']);
  });

  it('POST /action зовётся только из адаптера и speech.js', () => {
    // `transcribeViaAgent` — прямой выход к агенту внутри контракта. Если им начнут
    // пользоваться потребители, нарезка «байты → файл → /action» разъедется и очередной
    // путь снова соберёт свой вызов речи — ровно та история, что породила три копии.
    const stray = files
      .filter(f => /transcribeViaAgent/.test(code(f)))
      .map(f => f.split('/').pop())
      .filter(name => name !== 'speech.js');
    expect(stray,
      `Вызов POST /action минуя контракт: ${stray.join(', ')}\n` +
      'Используй src/lib/speech.js → transcribeAudio.')
      .toEqual([]);
  });
});
