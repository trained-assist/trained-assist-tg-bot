import { describe, expect, it } from 'vitest';
import { controlPlaneRunFailureCode, controlPlaneFailureText } from '../src/lib/control-plane-outcome.js';

describe('CP failure delivery', () => {
  const rejected = { generation: 1, status: 'failed', error_class: 'runner_rejected',
    error_text: 'ENGINE_NOT_ALLOWED: this API does not run engine "fixture" private-secret' };
  it('explains the rejected engine without exposing the underlying error text', () => {
    const text = controlPlaneFailureText({ generation: 1, runs: [rejected] });
    expect(text).toContain('выбранный движок недоступен');
    expect(text).toContain('Ввод сохранён');
    expect(text).not.toContain('private-secret');
    expect(controlPlaneRunFailureCode(rejected)).toBe('ENGINE_NOT_ALLOWED');
    expect(controlPlaneFailureText({ generation: 1, runs: [{ ...rejected, error_text: undefined, failure_code: 'ENGINE_NOT_ALLOWED' }] })).toBe(text);
  });
  it('never attributes an earlier generation, running or unknown attempt to this failure', () => {
    for (const change of [{ generation: 0 }, { generation: 2 }, { status: 'running' }, { status: 'unknown' }, { error_class: 'runner_unavailable' }]) {
      expect(controlPlaneFailureText({ generation: 1, runs: [{ ...rejected, ...change }] })).toBe('Ошибка исполнителя.');
    }
    expect(controlPlaneFailureText({ generation: 1, runs: [] })).toBe('Ошибка исполнителя.');
  });
});
