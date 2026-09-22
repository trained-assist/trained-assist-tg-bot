import { describe, it, expect } from 'vitest';
import { FORCE_RUN_RE, AUTO_LAUNCH_RE } from '../src/intake-routing.js';

describe('AUTO_LAUNCH_RE — standalone continuation/confirm signals', () => {
  it('matches known confirm words', () => {
    for (const w of ['продолжай', 'давай', 'ок', 'ok', 'yes', 'действуй']) {
      expect(AUTO_LAUNCH_RE.test(w)).toBe(true);
    }
  });

  it('matches a bare "?" (owner ask, 2026-09-22: a one-char confirm)', () => {
    expect(AUTO_LAUNCH_RE.test('?')).toBe(true);
    expect(AUTO_LAUNCH_RE.test(' ? ')).toBe(true);
  });

  it('does NOT match prose that merely contains a confirm word', () => {
    expect(AUTO_LAUNCH_RE.test('продолжай с вакансией')).toBe(false);
    expect(AUTO_LAUNCH_RE.test('а что если да?')).toBe(false);
  });
});

describe('FORCE_RUN_RE — explicit launch words', () => {
  it('matches standalone launch words only', () => {
    expect(FORCE_RUN_RE.test('запускай')).toBe(true);
    expect(FORCE_RUN_RE.test('го!')).toBe(true);
    expect(FORCE_RUN_RE.test('запускай проработку')).toBe(false);
  });
});
