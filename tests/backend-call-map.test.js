import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// ── Этап 0 контракта (issue #327, страница tgbot-decisions-2026-10-02) ──────
//
// «Карта обращений к backend должна совпадать с кодом»: полный перечень исходящих
// HTTP-вызовов бота к агенту зафиксирован здесь как факт. НОВЫЙ прямой вызов вне
// адаптера (src/lib/agent-client.js) падает этим тестом — его нужно либо провести
// через адаптер, либо осознанно добавить в карту вместе с обоснованием в PR.
//
// Это характеризация, а не идеальная картина: известные обходы адаптера
// (stats/cleanup-flood/maintenance/tasks/running/intake-quick/intake-files/
// outbox) перечислены намеренно — PR2 (LegacyBackend) переведёт их на адаптер,
// а PR по #302 снимет RU-маршрутизацию; каждая из этих правок обновит карту
// здесь, иначе CI красный. Тихого расширения границы не бывает.

const SRC = new URL('../src', import.meta.url).pathname;

function walk(dir) {
  return readdirSync(dir).flatMap(name => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.js') ? [full] : [];
  });
}

// Прямой вызов backend = fetch, чей URL собран из адреса агента (в т.ч. через
// локальный alias `base` в intake-files и `${base}` в fetchRunInput — туда
// подставляется AGENT_URL/pickAgentUrl). DO-стабы ('https://intake/…',
// 'https://outbox/…') — внутренняя маршрутизация; Telegram/Deepgram/RELAY —
// сторонние сервисы, ими контракт не занимается.
function backendCalls(source) {
  const calls = [];
  // fetch(`…`) — первый аргумент-шаблон, включая переносы строк.
  for (const m of source.matchAll(/fetch\(\s*`([^`]+)`/g)) {
    const tpl = m[1];
    if (!/AGENT_URL|agentUrl|\$\{base\}/.test(tpl)) continue;
    const path = tpl.match(/\$\{[^}]+\}([^?`]*?)(\?|$)/)?.[1]
      ?? (/endpoint\s*\(/.test(m[0]) ? '/intake-files*' : '(complex)');
    calls.push(path || '(complex)');
  }
  // fetch(endpoint(base, …)) — сборка URL хелпером в intake-files
  // (base — параметр с дефолтом env.AGENT_URL, отдельной RU-ветки тут нет).
  for (const m of source.matchAll(/fetch\(\s*endpoint\(/g)) calls.push('/intake-files*');
  return calls;
}

// Ожидаемая карта: файл → endpoint-ы. «*» — URL собирается helper'ом.
const EXPECTED = {
  'lib/agent-client.js': [
    '/capabilities', '/run', '/projects', '/project-decision', '/sessions',
    '/sessions/archive', '/files', '/files/read', '/classify', '/intake-gate',
    '/tokens', '/skills', '/report', '/health', '/internal/orphan-checklists/action',
    '/internal/run-input', '/tasks/stop',
    '/projects', // 2-й вызов: getProjects RU-ветка (probe AGENT_RU_URL) — #302 снимет
  ],
  'run-outbox.js': ['/maintenance', '/run'],
  'handlers/commands.js': ['/cleanup-flood', '/maintenance'],
  'handlers/user-mgmt.js': ['/stats'],
  'intake-buffer.js': ['/tasks/running'],
  'intake-preflight.js': ['/intake-quick'],
  'lib/intake-files.js': ['/intake-files*', '/intake-files*', '/intake-files/release'],
};

// Кто СМЕТ трогать адресата. Маршрутизация RU/EU — зона инфраструктуры
// (решение владельца 02.10.2026: выбор машины уходит из бота, #302/#326).
const PICK_AGENT_URL_IMPORTERS = ['intake-preflight.js'];
const RU_ADDRESS_USERS = ['handlers/commands.js', 'lib/agent-client.js', 'run-outbox.js'];

const files = walk(SRC).map(f => relative(SRC, f));
const read = file => readFileSync(join(SRC, file), 'utf8');

describe('карта обращений к backend (контракт #327, этап 0.2)', () => {
  it('прямые вызовы к backend идут только из файлов карты', () => {
    const offenders = [];
    for (const file of files) {
      if (file in EXPECTED) continue;
      const hits = backendCalls(read(file));
      if (hits.length) offenders.push({ file, hits });
    }
    expect(offenders, `Новые прямые вызовы к backend вне карты/адаптера: ${
      JSON.stringify(offenders, null, 2)}\nПроведи их через src/lib/agent-client.js либо добавь в EXPECTED с обоснованием в PR.`)
      .toEqual([]);
  });

  it('карта не устарела: каждый файл карты содержит ровно свои вызовы', () => {
    const mismatches = [];
    for (const [file, expectedPaths] of Object.entries(EXPECTED)) {
      const actual = [...backendCalls(read(file))].sort();
      const want = [...expectedPaths].sort();
      if (JSON.stringify(actual) !== JSON.stringify(want)) {
        mismatches.push({ file, expected: want, actual });
      }
    }
    expect(mismatches, `Карта разошлась с кодом: ${JSON.stringify(mismatches, null, 2)}`).toEqual([]);
  });

  it('pickAgentUrl импортирует только известный файл (маршрутизация не размножается)', () => {
    const importers = files.filter(file =>
      /import\s*\{[^}]*pickAgentUrl[^}]*\}\s*from/.test(read(file)));
    expect([...importers].sort()).toEqual(PICK_AGENT_URL_IMPORTERS);
  });

  it('AGENT_RU_URL не появляется в новых файлах (миграция #302/#326 инкрементальна)', () => {
    const users = files.filter(file => /AGENT_RU_URL/.test(read(file)));
    expect([...users].sort()).toEqual(RU_ADDRESS_USERS);
  });

  it('/capabilities вызывается только из адаптера', () => {
    const users = files.filter(file => /\/capabilities/.test(read(file)));
    expect([...users].sort()).toEqual(['lib/agent-client.js']);
  });
});
