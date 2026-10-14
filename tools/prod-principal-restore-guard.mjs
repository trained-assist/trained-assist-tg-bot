#!/usr/bin/env node
import { waitForProdPrincipalRestore } from './prod-principal-restore-guard-lib.mjs';
const url = 'https://trained-assist-tg-sandbox3.skillset-apply.workers.dev/operator/test-evidence';
const token = process.env.TG_SANDBOX3_OPERATOR_TOKEN?.trim();
if (!token) throw new Error('operator_token_required');
const result = await waitForProdPrincipalRestore(async () => {
  const response = await fetch(url, { cache: 'no-store', headers: { authorization: `Bearer ${token}`, 'cache-control': 'no-cache' },
    signal: AbortSignal.timeout(20_000) });
  return { status: response.status, evidence: await response.json().catch(() => ({})) };
});
console.log(JSON.stringify(result));
if (!result.safeToRestore) process.exitCode = 1;
