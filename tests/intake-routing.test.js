import { describe, it, expect } from 'vitest';
import { FORCE_RUN_RE, AUTO_LAUNCH_RE, shouldDebounce } from '../src/intake-routing.js';

describe('shouldDebounce — intake admission cannot fail open', () => {
  it('keeps content on the intake route when debounce is off or the binding is absent', () => {
    expect(shouldDebounce({ text: 'задача' }, { INTAKE_DEBOUNCE: 'off', INTAKE: {} })).toBe(true);
    expect(shouldDebounce({ text: 'задача' }, { INTAKE_DEBOUNCE: 'on' })).toBe(true);
  });
  it('keeps slash commands and empty updates on their dedicated path', () => {
    expect(shouldDebounce({ text: '/stop' }, { INTAKE: {} })).toBe(false);
    expect(shouldDebounce({ text: '' }, { INTAKE: {} })).toBe(false);
  });
});

describe('AUTO_LAUNCH_RE — standalone continuation/confirm signals', () => {
  it('matches known confirm words', () => {
    for (const w of ['продолжай', 'делай', 'всё готово', 'прямо сейчас делай', 'действуй']) {
      expect(AUTO_LAUNCH_RE.test(w)).toBe(true);
    }
  });

  it('acknowledgments and question marks are not explicit authorization', () => {
    for (const text of ['?', ' ? ', 'ок', 'ok', 'yes', 'давай', 'понял', 'ага', 'угу']) {
      expect(AUTO_LAUNCH_RE.test(text)).toBe(false);
    }
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
