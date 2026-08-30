import { describe, it, expect } from 'vitest';
import { isUserMgmtCommand } from '../src/handlers/user-mgmt.js';

describe('isUserMgmtCommand', () => {
  it.each([
    ['/adduser john'],
    ['/listusers'],
    ['/deluser bob'],
    ['/resetpass alice'],
    ['/um'],
    ['/stats'],
  ])('returns true for admin command: %s', (text) => {
    expect(isUserMgmtCommand(text)).toBe(true);
  });

  it.each([
    ['/start'],
    ['/login user pass'],
    ['/logout'],
    ['/status'],
    ['hello'],
    [''],
  ])('returns false for non-admin command: %s', (text) => {
    expect(isUserMgmtCommand(text)).toBe(false);
  });
});
