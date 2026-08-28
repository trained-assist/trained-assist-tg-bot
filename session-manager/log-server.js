const http = require('http');
const logBuffer = require('./log-buffer');

const TOKEN = process.env.LOG_VIEW_TOKEN || 'alesa2026';
const PORT = 8080;

const HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Alesa · Live Log</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #0d1117; color: #c9d1d9; font-family: 'Menlo','Monaco','Courier New',monospace; font-size: 13px; }
#status {
  position: sticky; top: 0; z-index: 10;
  padding: 10px 16px; background: #161b22;
  border-bottom: 1px solid #30363d;
  display: flex; align-items: center; gap: 10px;
}
#dot { width: 10px; height: 10px; border-radius: 50%; background: #3fb950; flex-shrink: 0; transition: background 0.3s; }
#dot.running { background: #e3b341; animation: pulse 1.2s ease-in-out infinite; }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.35} }
#label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; color: #8b949e; }
#label.active { color: #e3b341; }
#elapsed { color: #6e7681; font-size: 12px; flex-shrink: 0; min-width: 36px; text-align: right; }
#log { padding: 12px 16px 60px; }
.entry { display: flex; gap: 8px; line-height: 1.55; }
.t { color: #484f58; flex-shrink: 0; user-select: none; }
.l { white-space: pre-wrap; word-break: break-all; }
.l.sys { color: #58a6ff; }
#empty { color: #484f58; padding: 40px 16px; text-align: center; }
#done-msg { color: #3fb950; padding: 8px 16px; font-size: 12px; }
</style>
</head>
<body>
<div id="status">
  <div id="dot" class="running"></div>
  <div id="label" class="active">Загрузка…</div>
  <div id="elapsed"></div>
</div>
<div id="log"></div>
<script>
const params = new URLSearchParams(location.search);
const token = params.get('t') || '';
const taskId = params.get('id') || '';
let startedAt = null;
let lastCount = 0;
let done = false;

const logEl = document.getElementById('log');
const dotEl = document.getElementById('dot');
const labelEl = document.getElementById('label');
const elapsedEl = document.getElementById('elapsed');

function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function render(lines) {
  return lines.map(l => {
    const sys = l.text.startsWith('▶') || l.text.startsWith('✓');
    return '<div class="entry"><span class="t">' + l.t + '</span>' +
      '<span class="l' + (sys ? ' sys' : '') + '">' + esc(l.text) + '</span></div>';
  }).join('') || '<div id="empty">Ожидание вывода…</div>';
}

async function poll() {
  if (done) return;
  try {
    const r = await fetch('/api/state?t=' + encodeURIComponent(token) + '&id=' + encodeURIComponent(taskId));
    if (!r.ok) { labelEl.textContent = 'Нет доступа'; return; }
    const d = await r.json();

    if (d.notFound) {
      dotEl.className = '';
      labelEl.textContent = 'Сессия не найдена или истекла';
      labelEl.className = '';
      return;
    }

    if (d.isRunning) {
      dotEl.className = 'running';
      labelEl.textContent = d.currentTask || 'Думаю…';
      labelEl.className = 'active';
      startedAt = d.startedAt;
    } else {
      dotEl.className = '';
      labelEl.textContent = 'Готово';
      labelEl.className = '';
      elapsedEl.textContent = '';
      startedAt = null;
      done = true;
    }

    if (d.lines.length !== lastCount) {
      lastCount = d.lines.length;
      const atBottom = document.body.scrollHeight - window.scrollY - window.innerHeight < 80;
      logEl.innerHTML = render(d.lines);
      if (atBottom || done) window.scrollTo(0, document.body.scrollHeight);
    }
  } catch(e) {}
}

setInterval(() => {
  if (startedAt) {
    const s = Math.round((Date.now() - startedAt) / 1000);
    const m = Math.floor(s / 60);
    elapsedEl.textContent = m > 0 ? m + 'м ' + (s % 60) + 'с' : s + 'с';
  }
}, 1000);

poll();
const timer = setInterval(poll, 2000);
</script>
</body>
</html>`;

function createServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const t = url.searchParams.get('t');

    if (t !== TOKEN) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('403 Forbidden');
      return;
    }

    if (url.pathname === '/api/state') {
      const taskId = url.searchParams.get('id');
      const state = taskId ? logBuffer.getState(taskId) : null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(state || { notFound: true }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Log server: 127.0.0.1:${PORT}`);
  });

  return server;
}

module.exports = { createServer, TOKEN, PORT };
