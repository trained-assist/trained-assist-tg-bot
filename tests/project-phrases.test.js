import { describe, it, expect } from 'vitest';
import { chatConfigCommandFromPhrase as cmd, isProjectSwitch } from '../src/lib/project-command.js';

// Plain-language chat-config phrases map to the agent's /project and /settings commands
// (user report 2026-09-25: no way to see/change/clear the chat's pinned project).
describe('chatConfigCommandFromPhrase', () => {
  it('maps pin-state phrases', () => {
    expect(cmd('текущий проект')).toBe('/project current');
    expect(cmd('Какой проект закреплён?')).toBe('/project current');
    expect(cmd('сменить проект')).toBe('/project');
    expect(cmd('закрепи Фриланс-заказы')).toBe('/project pin Фриланс-заказы');
    expect(cmd('закрепи проект «Фриланс-заказы»')).toBe('/project pin Фриланс-заказы');
    expect(cmd('смени проект на Фриланс-заказы')).toBe('/project pin Фриланс-заказы');
    expect(cmd('сними закрепление проекта')).toBe('/project unpin');
    expect(cmd('открепи проект')).toBe('/project unpin');
    expect(cmd('верни автоматический выбор проекта')).toBe('/project unpin');
  });
  it('maps settings phrases', () => {
    for (const t of ['покажи настройки', 'настройки', 'settings', 'get config', 'user settings', 'конфиг']) expect(cmd(t)).toBe('/settings');
  });
  it('leaves real tasks alone', () => {
    expect(cmd('закрепи это сообщение')).toBeNull();
    expect(cmd('закрепи задачу на завтра')).toBeNull();
    expect(cmd('сделай настройки для сайта клиента')).toBeNull();
    expect(cmd('текущий проект сломан, почини деплой')).toBeNull();
    expect(cmd('закрепи Фриланс\nи сделай ТЗ')).toBeNull();
    expect(cmd('/project')).toBeNull();
  });
});

describe('isProjectSwitch', () => {
  it('pin/unpin reset the gateway project cache; list/current do not', () => {
    expect(isProjectSwitch('/project pin Фриланс')).toBe(true);
    expect(isProjectSwitch('/project unpin')).toBe(true);
    expect(isProjectSwitch('/project current')).toBe(false);
    expect(isProjectSwitch('/project')).toBe(false);
  });
});
