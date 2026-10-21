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

  it('treats a failed run with no visible outcome as an empty result, not a generic task failure (Ddd)', () => {
    const status = { generation: 1, status: 'failed', result: { answer: null, reason: 'no_user_visible_outcome' },
      runs: [{ generation: 1, status: 'failed', error_class: 'runner_rejected', error_text: 'no_user_visible_outcome' }] };
    const text = controlPlaneFailureText(status);
    expect(text).not.toBe('Ошибка исполнителя.');
    expect(text).toContain('без текстового ответа');
  });

  it('explains a worker crash instead of reporting a generic executor error', () => {
    const crashed = { generation: 2, status: 'failed', error_class: 'WORKER_CRASH',
      error_text: 'worker restarted while the run was active; execution outcome recorded as lost without a hidden rerun' };
    const text = controlPlaneFailureText({ generation: 2, runs: [crashed] });
    expect(text).not.toBe('Ошибка исполнителя.');
    expect(text).toContain('сбой среды исполнения');
    expect(text).toContain('Ввод сохранён');
    expect(controlPlaneRunFailureCode(crashed)).toBe('WORKER_CRASH');
  });

  it('never attributes a crash of another generation or a running attempt to this failure', () => {
    const crashed = { generation: 2, status: 'failed', error_class: 'WORKER_CRASH' };
    for (const change of [{ generation: 1 }, { generation: 3 }, { status: 'running' }, { status: 'success' },
      { error_class: 'runner_unavailable' }]) {
      expect(controlPlaneFailureText({ generation: 2, runs: [{ ...crashed, ...change }] })).toBe('Ошибка исполнителя.');
    }
    expect(controlPlaneFailureText({ generation: 0, runs: [crashed] })).toBe('Ошибка исполнителя.');
    expect(controlPlaneFailureText({ generation: 2, runs: [] })).toBe('Ошибка исполнителя.');
  });

  it('keeps the engine rejection explanation separate from the worker crash one', () => {
    const rejected = { generation: 1, status: 'failed', error_class: 'runner_rejected',
      error_text: 'ENGINE_NOT_ALLOWED: this API does not run engine "fixture" private-secret' };
    const text = controlPlaneFailureText({ generation: 1, runs: [rejected] });
    expect(text).toContain('выбранный движок недоступен');
    expect(text).not.toContain('сбой среды исполнения');
  });
});
