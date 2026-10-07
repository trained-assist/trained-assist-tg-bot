const gateway = process.env.TG_STAGING_GATEWAY_URL || 'https://trained-assist-tg-bot-staging.skillset-apply.workers.dev';
const webhookSecret = process.env.TG_STAGING_WEBHOOK_SECRET;
const agentSecret = process.env.TG_STAGING_AGENT_SECRET;
const chatId = Number(process.env.TG_STAGING_CHAT_ID || '24790956');
const senderId = Number(process.env.TG_STAGING_SENDER_ID || String(chatId));
if (!webhookSecret || !agentSecret || !Number.isSafeInteger(chatId) || !Number.isSafeInteger(senderId)) {
  throw new Error('Missing staging test bindings');
}
const headers = {
  'content-type': 'application/json',
  'user-agent': 'tg-staging-user-path-e2e/1.0',
  'X-Telegram-Bot-Api-Secret-Token': webhookSecret,
};
const stateUrl = `${gateway}/debug/intake/${chatId}`;
async function readState() {
  const response = await fetch(stateUrl, { headers: { Authorization: `Bearer ${agentSecret}`, 'user-agent': headers['user-agent'] } });
  if (!response.ok) throw new Error(`intake state returned HTTP ${response.status}`);
  return response.json();
}
function summarize(state) {
  return {
    busy: !!state.busy,
    bufferedMessages: Array.isArray(state.buf) ? state.buf.length : 0,
    retryMessages: Array.isArray(state.retryBatch) ? state.retryBatch.length : 0,
    launching: !!state.launching,
    stranded: !!state.stranded,
  };
}
const before = summarize(await readState());
if (before.busy || before.bufferedMessages || before.retryMessages || before.launching || before.stranded) {
  throw new Error(`Staging chat is occupied; refusing to mutate it: ${JSON.stringify(before)}`);
}
const baseId = Date.now();
const cases = [
  { label: 'agent command', text: '/help' },
  { label: 'quick answer', text: 'работает?' },
  { label: 'ordinary task', text: 'Составь короткую безопасную фразу о готовности тестового стенда.' },
];
for (let i = 0; i < cases.length; i++) {
  const test = cases[i];
  const id = baseId + i;
  const update = {
    update_id: id,
    message: {
      message_id: id,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'private' },
      from: { id: senderId, is_bot: false, first_name: 'Telegram Patrol' },
      text: test.text,
    },
  };
  const response = await fetch(`${gateway}/webhook`, {
    method: 'POST', headers, body: JSON.stringify(update),
  });
  if (!response.ok) throw new Error(`${test.label}: webhook returned HTTP ${response.status}`);
  console.log(`${test.label}: webhook accepted (HTTP ${response.status})`);
  await new Promise(resolve => setTimeout(resolve, 1500));
}
// Allow the webhook's waitUntil dispatch, run outbox alarm, and agent callback to settle.
let after = summarize(await readState());
for (let attempt = 0; attempt < 18 && (after.busy || after.bufferedMessages || after.retryMessages || after.launching || after.stranded); attempt++) {
  await new Promise(resolve => setTimeout(resolve, 2500));
  after = summarize(await readState());
}
console.log(`intake settled: ${JSON.stringify(after)}`);
if (after.busy || after.bufferedMessages || after.retryMessages || after.launching || after.stranded) throw new Error('Staging chat did not settle after the E2E requests');
