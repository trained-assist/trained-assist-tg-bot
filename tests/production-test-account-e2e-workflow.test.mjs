import { readFileSync } from 'node:fs';
import { it, expect } from 'vitest';

const workflow = readFileSync(new URL('../.github/workflows/production-test-account-e2e.yml', import.meta.url), 'utf8');
const script = readFileSync(new URL('../tools/prod-two-move-canary.mjs', import.meta.url), 'utf8');

it('runs only from main, with fixed production bot URL and the existing test account', () => {
  expect(workflow).toContain("github.ref == 'refs/heads/main'");
  expect(workflow).toContain('WORKER_URL: https://trained-assist-tg-bot.skillset-apply.workers.dev');
  expect(workflow).toContain("CHAT_ID: '1714048'");
  expect(workflow).toContain('EXPECTED_BUILD_SHA: ${{ inputs.expected_build_sha || github.sha }}');
  expect(workflow).toContain('Exact deployed production bot SHA (defaults to this workflow revision)');
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

it('limits the no-answer retry scenario to the fixed production test account and requires delivered text', () => {
  expect(workflow).toContain('options: [context, architecture, empty-answer-retry, voice-ingress]');
  expect(script).toContain("const EMPTY_ANSWER_RETRY = process.env.E2E_SCENARIO === 'empty-answer-retry'");
  expect(script).toContain("assert.equal(CHAT_ID, 1714048, 'fixed_test_account_required')");
  expect(script).toContain("assert.ok(result.answerText.trim().length > 0, 'retry_answer_empty')");
  expect(script).toContain('last time you completed without outcome');
  expect(script).toContain('retry_returned_empty_result_placeholder');
  expect(script).toContain('deliveredAnswerSha256: result.move.answerSha256');
});

it('voice canary uploads a synthetic Opus fixture and injects only into the fixed production test account', () => {
  expect(script).toContain("const VOICE_INGRESS = process.env.E2E_SCENARIO === 'voice-ingress'");
  expect(script).toContain("new URL('../tests/fixtures/production-voice-canary.ogg', import.meta.url)");
  expect(script).toContain('sendVoice');
  expect(script).toContain("assert.equal(CHAT_ID, 1714048, 'fixed_test_account_required')");
  expect(script).toContain("assert.equal(result.move.status, 'sent', 'voice_answer_not_sent')");
  expect(script).toContain('voice_transcript_missing_from_intake');
});
