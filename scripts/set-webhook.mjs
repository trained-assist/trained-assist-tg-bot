#!/usr/bin/env node
// One-shot script: point a bot's Telegram webhook at its Worker and (optionally)
// register a secret_token. When a secret is set, Telegram echoes it in the
// X-Telegram-Bot-Api-Secret-Token header on every delivery and the Worker
// rejects unsigned updates (src/index.js#/webhook, issue #1302 §4.3).
//
// Usage:
//   BOT_TOKEN=xxx node scripts/set-webhook.mjs https://<worker>.workers.dev/webhook
//   BOT_TOKEN=xxx WEBHOOK_SECRET=yyy node scripts/set-webhook.mjs https://<worker>.workers.dev/webhook
//
// The secret must also be set as the Worker secret (so the same value is used
// on both sides):
//   wrangler secret put TELEGRAM_WEBHOOK_SECRET --env freelance
//
// Note: with `drop_pending_updates` left at its default (false) already-queued
// updates are replayed. Pass DROP_PENDING=1 to discard them on the switch.

const token = process.env.BOT_TOKEN || process.argv[2];
const url = process.env.WEBHOOK_URL || process.argv[3];
if (!token || !url) {
  console.error('Usage: BOT_TOKEN=xxx [WEBHOOK_SECRET=yyy] node scripts/set-webhook.mjs <webhook-url>');
  process.exit(1);
}

const body = { url, allowed_updates: ['message', 'callback_query'] };
if (process.env.WEBHOOK_SECRET) body.secret_token = process.env.WEBHOOK_SECRET;
if (process.env.DROP_PENDING === '1') body.drop_pending_updates = true;

const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const json = await res.json();
if (json.ok) {
  console.log(`✅ Webhook set: ${url}${body.secret_token ? ' (secret_token set)' : ' (no secret_token)'}`);
} else {
  console.error('❌ Ошибка:', JSON.stringify(json));
  process.exit(1);
}
