const { spawn } = require('child_process');
const { randomBytes } = require('crypto');
const { AUTH_FAIL_RE } = require('./auth');
const logBuffer = require('./log-buffer');

const MAX_LEN = 3800;
const EDIT_INTERVAL = 3000;

async function runTask({ user, task, authManager, telegram, chatId, context, filesToCleanup = [] }) {
  const taskId = randomBytes(4).toString('hex');
  logBuffer.createTask(taskId, task.slice(0, 80));

  const initial = await telegram.sendMessage(chatId, '⏳ Думаю…');
  const msgId = initial.message_id;

  return new Promise((resolve) => {
    const env = authManager.getSessionEnv();
    const proc = spawn('claude', ['--dangerously-skip-permissions'], {
      env,
      cwd: user.workDir,
    });

    const fullInput = context ? `${context}\n\n---\n\n${task}` : task;
    proc.stdin.write(fullInput);
    proc.stdin.end();

    let output = '';
    let lastEdited = '';
    const startMs = Date.now();
    let lastElapsedUpdate = 0;
    let backoffUntil = 0; // ms timestamp: skip edits until after this

    const tryEdit = async () => {
      const now = Date.now();
      if (now < backoffUntil) return; // rate-limit backoff active

      const sec = Math.round((now - startMs) / 1000);
      const m = Math.floor(sec / 60), s = sec % 60;
      const elapsed = m > 0 ? `${m}м ${s}с` : `${s}с`;

      if (output.trim()) {
        // Real output arrived — show it
        const snippet = output.slice(-MAX_LEN).trim();
        if (snippet === lastEdited) return;
        lastEdited = snippet;
        try {
          await telegram.editMessageText(chatId, msgId, null, snippet);
        } catch (e) {
          const retryAfter = e?.response?.parameters?.retry_after;
          if (retryAfter) backoffUntil = Date.now() + retryAfter * 1000;
        }
      } else {
        // Still thinking — update elapsed time every 10s
        if (now - lastElapsedUpdate < 10000) return;
        lastElapsedUpdate = now;
        const thinking = `⏳ Думаю… ${elapsed}`;
        lastEdited = thinking;
        try {
          await telegram.editMessageText(chatId, msgId, null, thinking);
        } catch (e) {
          const retryAfter = e?.response?.parameters?.retry_after;
          if (retryAfter) backoffUntil = Date.now() + retryAfter * 1000;
        }
      }
    };

    const timer = setInterval(tryEdit, EDIT_INTERVAL);

    proc.stdout.on('data', c => { const s = c.toString(); output += s; logBuffer.push(taskId, s); });
    proc.stderr.on('data', c => { const s = c.toString(); output += s; logBuffer.push(taskId, s); });

    proc.on('error', async (err) => {
      clearInterval(timer);
      logBuffer.setDone(taskId);
      try { await telegram.editMessageText(chatId, msgId, null, `❌ Ошибка процесса: ${err.message}`); } catch {}
      resolve(null);
    });

    proc.on('close', async () => {
      clearInterval(timer);
      logBuffer.setDone(taskId);
      const result = output.trim() || '(нет вывода)';

      if (AUTH_FAIL_RE.test(result)) {
        try { await telegram.deleteMessage(chatId, msgId); } catch {}
        authManager.handleAuthFailure('task');
        resolve(null);
        return;
      }

      const chunks = [];
      for (let i = 0; i < result.length; i += MAX_LEN) {
        chunks.push(result.slice(i, i + MAX_LEN));
      }

      try {
        await telegram.editMessageText(chatId, msgId, null, chunks[0]);
      } catch {
        await telegram.sendMessage(chatId, chunks[0]);
      }

      for (let i = 1; i < chunks.length; i++) {
        await telegram.sendMessage(chatId, chunks[i]);
      }

      for (const f of filesToCleanup) {
        try { require('fs').unlinkSync(f); } catch {}
      }

      resolve(result);
    });
  });
}

module.exports = { runTask };
