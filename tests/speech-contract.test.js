import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Контракт Ф4 (trained-assist-tg-bot#319): у шлюза ОДИН путь распознавания речи —
// sibling-скил speech_transcribe через POST /action агента.
//
// До #319 у боя были три копии прямых вызовов Deepgram (media-jobs / transcribeVoice /
// debug-роут): свой ключ в env воркера, свои ретраи, свой таймаут, своё определение
// формата. Каждая копия жила своим жизнью и ломалась по-своему. Этот тест — та самая
// «дыра в классе»: убрать одну копию недостаточно, если ничто не мешает вернуть её.
//
// Правило: в src/** не должно остаться ни адреса Deepgram, ни ссылки на ключ из
// переменных окружения воркера. Любой новый инлайн-вызов → красный CI, и его надо
// провести через src/lib/speech.js, а не оставить второй точкой правки.

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

describe('контракт Ф4: один клиент распознавания речи (#319)', () => {
  it('в src нет прямых вызовов Deepgram', () => {
    const offenders = files.filter(f => /api\.deepgram\.com/.test(code(f)));
    expect(offenders,
      `Прямой вызов Deepgram вернулся в шлюз: ${offenders.join(', ')}\n` +
      'Проведи распознавание через src/lib/speech.js (PUT /intake-files + POST /action).')
      .toEqual([]);
  });

  it('в src нет ссылки на ключ Deepgram в переменных окружения воркера', () => {
    const offenders = files.filter(f => /DEEPGRAM_API_KEY/.test(code(f)));
    expect(offenders,
      `env.DEEPGRAM_API_KEY снова читается из кода: ${offenders.join(', ')}\n` +
      'Ключ живёт на агенте (скил speech), у воркера он больше не нужен.')
      .toEqual([]);
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
