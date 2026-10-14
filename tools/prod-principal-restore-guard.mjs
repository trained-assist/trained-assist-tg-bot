#!/usr/bin/env node
import { waitForProdPrincipalRestore } from './prod-principal-restore-guard-lib.mjs';
const url = 'https://trained-assist-tg-sandbox3.skillset-apply.workers.dev/operator/test-evidence';
const token = process.env.TG_SANDBOX3_OPERATOR_TOKEN?.trim();
if (!token) throw new Error('operator_token_required');
const result = await waitForProdPrincipalRestore(async () => {
  const response = await fetch(url, { cache: 'no-store', headers: { authorization: `Bearer ${token}`, 'cache-control': 'no-cache' },
    signal: AbortSignal.timeout(20_000) });
  return { status: response.status, evidence: await response.json().catch(() => ({})) };
}, { cleanupStrandedDraft: async () => {
  const response = await fetch('https://trained-assist-tg-sandbox3.skillset-apply.workers.dev/operator/test-cleanup', {
    method: 'POST', cache: 'no-store', headers: { authorization: `Bearer ${token}`, 'cache-control': 'no-cache',
      'content-type': 'application/json' },
    body: JSON.stringify({ target: 'prod-principal', confirm: 'CLEAN_PINNED_TEST_CHAT' }),
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => ({}));
  return response.ok && payload.ok === true && payload.clearedBindings?.includes('intake');
} });
console.log(JSON.stringify(result));
if (!result.safeToRestore) process.exitCode = 1;
