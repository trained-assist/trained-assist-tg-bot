/**
 * Локальный HTTP сервер на Mac — принимает запрос от VM бота,
 * читает Claude token из Keychain и SCP-ит на VM.
 *
 * Запуск: node auth-sync-server.js
 * Порт: 7755 (только localhost — expose через Cloudflare или ngrok при необходимости)
 */

const http = require('http');
const { execSync, exec } = require('child_process');

const PORT = 7755;
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const VM_HOST = 'alesa-vm';
const VM_ZONE = 'us-central1-a';
const VM_PROJECT = 'alesa-personal-assistent';
const VM_CRED_PATH = '/home/vova/.claude/.credentials.json';

// Secret token so random callers can't trigger a sync
const SYNC_SECRET = process.env.SYNC_SECRET || 'alesa-sync-2026';

function syncToken() {
  return new Promise((resolve, reject) => {
    let credJson;
    try {
      const raw = execSync(
        `security find-generic-password -s "${KEYCHAIN_SERVICE}" -w`,
        { encoding: 'utf8', timeout: 5000 }
      ).trim();
      const parsed = JSON.parse(raw);
      const oauthEntry = parsed.claudeAiOauth;
      if (!oauthEntry?.accessToken?.startsWith('sk-ant')) {
        return reject(new Error('Token not found or invalid in Keychain'));
      }
      credJson = JSON.stringify({ claudeAiOauth: oauthEntry });
    } catch (err) {
      return reject(new Error(`Keychain read failed: ${err.message}`));
    }

    // Escape JSON for shell heredoc
    const escaped = credJson.replace(/'/g, "'\\''");
    const cmd = `echo '${escaped}' | gcloud compute ssh ${VM_HOST} \
      --zone=${VM_ZONE} --project=${VM_PROJECT} \
      --command="mkdir -p /home/vova/.claude && cat > ${VM_CRED_PATH} && chmod 600 ${VM_CRED_PATH}" \
      -- -o StrictHostKeyChecking=no`;

    exec(cmd, { timeout: 30000 }, (err) => {
      if (err) return reject(new Error(`SCP failed: ${err.message}`));
      resolve('ok');
    });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/sync-auth') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const { secret } = JSON.parse(body || '{}');
        if (secret !== SYNC_SECRET) {
          res.writeHead(403);
          return res.end(JSON.stringify({ error: 'Forbidden' }));
        }

        console.log(`[${new Date().toISOString()}] Sync requested — reading Keychain…`);
        await syncToken();
        console.log(`[${new Date().toISOString()}] ✅ Token synced to VM`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: 'Token synced' }));
      } catch (err) {
        console.error(`[sync] ❌ ${err.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200);
    return res.end('ok');
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`🔑 Auth sync server running on localhost:${PORT}`);
  console.log(`   POST /sync-auth  { "secret": "${SYNC_SECRET}" }`);
});
