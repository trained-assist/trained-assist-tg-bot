import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const base = 'https://trained-assist-tg-bot.skillset-apply.workers.dev';
export async function runParagraphDeliverySmoke(env = process.env, fetchImpl = fetch, wait = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  const report = { ok: false, scenario: 'complete-paragraph-delivery', phase: 'configuration', chatId: 1714048 };
  const save = () => { if (env.EVIDENCE_OUT) writeFileSync(env.EVIDENCE_OUT, JSON.stringify(report, null, 2), { mode: 0o600 }); };
  const require = condition => { if (!condition) throw new Error('probe_assertion_failed'); };
  try {
    require(typeof env.AGENT_SECRET === 'string' && env.AGENT_SECRET.length >= 6);
    require(/^[a-f0-9]{40}$/.test(env.EXPECTED_BUILD_SHA ?? ''));
    const runKey = env.GITHUB_RUN_ID ? `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT ?? '1'}` : randomUUID();
    require(/^[a-zA-Z0-9-]{1,80}$/.test(runKey));
    const deliveryId = `paragraph-probe:${runKey}`;
    const text = Array.from({ length: 5 }, (_, i) => `Раздел ${i + 1}. ${'Проверка полного текста и границы абзаца. '.repeat(27)}`).join('\n\n');
    Object.assign(report, { deliveryId, sourceCharacters: text.length,
      sourceSha256: createHash('sha256').update(text).digest('hex') });save();
    const call = async (path, body) => {
      const response = await fetchImpl(base + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        headers: { authorization: `Bearer ${env.AGENT_SECRET}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
      return { status: response.status, value: await response.json() };
    };
    report.phase = 'exact_worker_revision';save();
    const health = await call('/health');require(health.status === 200 && health.value.buildSha === env.EXPECTED_BUILD_SHA);
    report.buildSha = health.value.buildSha;
    const payload = { deliveryId, userTaskId: `paragraph-probe-${runKey}`, taskAcceptedAt: Date.now(), channel: 'telegram',
      destinationId: '1714048', message: { kind: 'result', text } };
    report.phase = 'send_complete_result';save();
    let accepted;
    for (let attempt = 0; attempt < 12; attempt++) {
      const reply = await call('/deliver', payload);
      if (reply.status === 200 && Number.isSafeInteger(reply.value.providerMessageId)) { accepted = reply.value;break; }
      require(reply.status === 503 && reply.value.outcome === 'pending');
      await wait(1100);
    }
    require(accepted);
    report.phase = 'verify_aggregate_acknowledgement';save();
    const evidence = await call('/debug/deliveries?chatId=1714048&limit=100');require(evidence.status === 200);
    const record = evidence.value.deliveries?.find(item => item.deliveryId === deliveryId);
    require(record?.status === 'sent' && record.partCount > 1 && record.sentParts === record.partCount);
    require(record.textCharacterCount === report.sourceCharacters && record.textSha256 === report.sourceSha256);
    require(record.providerMessageIds?.length === record.partCount && new Set(record.providerMessageIds).size === record.partCount);
    const replay = await call('/deliver', payload);
    require(replay.status === 200 && replay.value.duplicate === true && replay.value.providerMessageId === accepted.providerMessageId);
    Object.assign(report, { ok: true, phase: 'verified', parts: record.partCount, sentParts: record.sentParts,
      providerMessageIds: record.providerMessageIds, replaySameAcknowledgement: true });
  } catch { report.reason = report.phase; }
  save();return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runParagraphDeliverySmoke();console.log(JSON.stringify(report));if (!report.ok) process.exitCode = 1;
}
