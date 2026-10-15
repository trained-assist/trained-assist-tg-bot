import { it, expect, vi } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { deployMainWorker } from '../tools/deploy-main-worker.mjs';

const env = { BUILD_SHA: 'c'.repeat(40), ADMIN_GROUP_ID: '-100123',
  CONTROL_PLANE_PRINCIPAL_SIGNATURE: 'a'.repeat(64), CONTROL_PLANE_SECRET: 'b'.repeat(64) };

it.each([0, 1])('deploys code and secrets together, then removes the private file after exit %s', status => {
  let secretFile;
  const invoke = vi.fn((command, args, options) => {
    expect(command).toBe('npx');
    expect(args.slice(0, 5)).toEqual(['wrangler', 'deploy', '--env=', '--name', 'trained-assist-tg-bot']);
    secretFile = args[args.indexOf('--secrets-file') + 1];
    expect(statSync(secretFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(secretFile, 'utf8'))).toEqual({ ADMIN_GROUP_ID: env.ADMIN_GROUP_ID,
      CONTROL_PLANE_PRINCIPAL_SIGNATURE: env.CONTROL_PLANE_PRINCIPAL_SIGNATURE, CONTROL_PLANE_SECRET: env.CONTROL_PLANE_SECRET });
    expect(args).toContain(`BUILD_SHA:${env.BUILD_SHA}`);
    expect(JSON.stringify(args)).not.toContain(env.CONTROL_PLANE_SECRET);
    expect(options.stdio).toBe('inherit');
    return { status };
  });
  expect(deployMainWorker({ env, invoke })).toBe(status);
  expect(invoke).toHaveBeenCalledOnce();
  expect(existsSync(secretFile)).toBe(false);
});

it.each(['BUILD_SHA', 'ADMIN_GROUP_ID', 'CONTROL_PLANE_PRINCIPAL_SIGNATURE', 'CONTROL_PLANE_SECRET'])('refuses missing %s before touching deployment', name => {
  const invoke = vi.fn();
  expect(() => deployMainWorker({ env: { ...env, [name]: '' }, invoke })).toThrow();
  expect(invoke).not.toHaveBeenCalled();
});

it('removes secrets if starting the CLI throws', () => {
  let file;
  expect(() => deployMainWorker({ env, invoke: (_command, args) => {
    file = args[args.indexOf('--secrets-file') + 1]; throw new Error('spawn failed');
  } })).toThrow('spawn failed');
  expect(existsSync(file)).toBe(false);
});
