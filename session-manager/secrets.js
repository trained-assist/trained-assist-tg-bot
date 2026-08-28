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

async function loadSecrets() {
  const [
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID,
    ANTHROPIC_API_KEY,
    DEEPGRAM_API_KEY,
    AUTH_SYNC_URL,
  ] = await Promise.allSettled([
    getSecret('TELEGRAM_BOT_TOKEN'),
    getSecret('TELEGRAM_CHAT_ID'),
    getSecret('ANTHROPIC_API_KEY'),
    getSecret('DEEPGRAM_API_KEY'),
    getSecret('AUTH_SYNC_URL'),
  ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : null));

  return {
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: Number(TELEGRAM_CHAT_ID),
    ANTHROPIC_API_KEY,
    DEEPGRAM_API_KEY,
    AUTH_SYNC_URL, // null if not configured yet — that's OK
  };
}

module.exports = { loadSecrets };
