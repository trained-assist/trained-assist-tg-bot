import { it, expect } from 'vitest';
import { readTgSliceConfig, chatAllowed, TgSliceConfigError } from '../src/sandbox-tg/config.js';

const baseEnv = {
  BOT_USERNAME: 'super_personal_assistant_bot',
  EXECUTION_BACKEND: 'control-plane',
  CONTROL_PLANE_URL: 'https://trained-assist-cp-production.skillset-apply.workers.dev',
  CONTROL_PLANE_PRINCIPAL: 'gateway',
  CONTROL_PLANE_PROFILE: 'trained-assist-production',
  CONTROL_PLANE_PRINCIPAL_SIGNATURE: 'a'.repeat(64),
  CONTROL_PLANE_SECRET: 'b'.repeat(64),
  BOT_TOKEN: 'prod-bot-token',
  TG_SLICE_ALLOWED_CHATS: '',
  TG_SLICE_ALLOWED_USERS: '',
};

it('admits the ordinary production lane (productionMode) for a production bot on control-plane', () => {
  const config = readTgSliceConfig(baseEnv);
  expect(config.productionMode).toBe(true);
  expect(config.principalId).toBe('gateway');
  expect(config.profileId).toBe('trained-assist-production');
  expect(config.principalSignature).toBe('a'.repeat(64));
});

it('opens the production lane to every chat', () => {
  const config = readTgSliceConfig(baseEnv);
  expect(chatAllowed(config, '123456')).toBe(true);
  expect(chatAllowed(config, '-999999999')).toBe(true);
});

it('fails closed when a production bot is not control-plane and not the E2E lane', () => {
  expect(() => readTgSliceConfig({ ...baseEnv, EXECUTION_BACKEND: 'legacy-agent' }))
    .toThrow(TgSliceConfigError);
});

it('requires a principal signature in production mode', () => {
  expect(() => readTgSliceConfig({ ...baseEnv, CONTROL_PLANE_PRINCIPAL_SIGNATURE: '' }))
    .toThrow(TgSliceConfigError);
});
