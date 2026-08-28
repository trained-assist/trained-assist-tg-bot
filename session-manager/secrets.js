/**
 * Loads all credentials from Google Cloud Secret Manager.
 * VM accesses them via its service account — no files on disk.
 */

const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

const client = new SecretManagerServiceClient();
const PROJECT = 'alesa-personal-assistent';

async function getSecret(name) {
  const [version] = await client.accessSecretVersion({
    name: `projects/${PROJECT}/secrets/${name}/versions/latest`,
  });
  return version.payload.data.toString('utf8').trim();
}

const REQUIRED = ['TELEGRAM_BOT_TOKEN', 'ANTHROPIC_API_KEY'];
const OPTIONAL = ['TELEGRAM_CHAT_ID', 'DEEPGRAM_API_KEY', 'AUTH_SYNC_URL', 'AUTH_SYNC_SECRET', 'BOT_SECRET'];

async function loadSecrets() {
  const names = [...REQUIRED, ...OPTIONAL];
  const results = await Promise.allSettled(names.map(n => getSecret(n)));
  const values = Object.fromEntries(names.map((n, i) => [
    n,
    results[i].status === 'fulfilled' ? results[i].value : null,
  ]));

  for (const name of REQUIRED) {
    if (!values[name]) throw new Error(`Required secret missing from Secret Manager: ${name}`);
  }

  return {
    TELEGRAM_BOT_TOKEN: values.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: values.TELEGRAM_CHAT_ID ? Number(values.TELEGRAM_CHAT_ID) : null,
    ANTHROPIC_API_KEY: values.ANTHROPIC_API_KEY,
    DEEPGRAM_API_KEY: values.DEEPGRAM_API_KEY,
    AUTH_SYNC_URL: values.AUTH_SYNC_URL,         // null if not configured
    AUTH_SYNC_SECRET: values.AUTH_SYNC_SECRET,   // null if not configured
    BOT_SECRET: values.BOT_SECRET,               // null if not configured (disables chrome ext commands)
  };
}

module.exports = { loadSecrets };
