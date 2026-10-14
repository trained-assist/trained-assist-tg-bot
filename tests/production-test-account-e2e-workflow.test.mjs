import { readFileSync } from 'node:fs';
import { it, expect } from 'vitest';

const workflow = readFileSync(new URL('../.github/workflows/production-test-account-e2e.yml', import.meta.url), 'utf8');
const script = readFileSync(new URL('../tools/prod-two-move-canary.mjs', import.meta.url), 'utf8');

it('runs only from main, with fixed production bot URL and the existing test account', () => {
  expect(workflow).toContain("github.ref == 'refs/heads/main'");
  expect(workflow).toContain('WORKER_URL: https://trained-assist-tg-bot.skillset-apply.workers.dev');
  expect(workflow).toContain("CHAT_ID: '1714048'");
  expect(workflow).toContain('EXPECTED_BUILD_SHA: ${{ github.sha }}');
  expect(workflow).toContain('secrets.BOT_TOKEN');
  expect(workflow).not.toContain('TG_SANDBOX_BOT_USERNAME');
  expect(workflow).not.toContain('CONTROL_PLANE_URL');
});

it('checks production bot identity, routing availability, clean Intake, and exact deployed SHA before sending', () => {
  expect(script).toContain("EXPECTED_BOT_USERNAME = 'super_personal_assistant_bot'");
  expect(script).toContain("assert.equal(health.buildSha, EXPECTED_BUILD_SHA, 'production_build_sha_mismatch')");
  expect(script).toContain("assert.equal(health.ingressPaused, false, 'ingress_paused')");
  expect(script).toContain("assert.equal(health.deliveryPaused, false, 'delivery_paused')");
  expect(script).toContain("assert.deepEqual(intake.buf ?? [], [], 'intake_buf_not_empty_at_preflight')");
  expect(script).toContain("assert.deepEqual(intake.retryBatch ?? [], [], 'intake_retry_batch_not_empty_at_preflight')");
});
