const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { AUTH_FAIL_RE } = require('./auth');

const SESSIONS_DIR = '/home/vova/alesa-sessions';
const PERSIST_FILE = path.join(SESSIONS_DIR, 'sessions.json');

class SessionManager {
  constructor({ authManager, bot }) {
    this.authManager = authManager;
    this.bot = bot;
    this._sessions = new Map(); // userId → Map(sessionName → { taskDescription, summary, createdAt })
    this._userRefs = new Map();
    this._watchIntervals = new Map(); // sessionName → intervalId
  }

  // Load saved sessions from disk. tmux may be dead after restart — that's fine,
  // context (lastQuestion/lastResponse) lives in the JSON, not in tmux.
  loadFromDisk() {
    try {
      const raw = JSON.parse(fs.readFileSync(PERSIST_FILE, 'utf8'));
      let restored = 0;
      for (const [userId, userSessions] of Object.entries(raw)) {
        const map = new Map();
        for (const [name, sess] of Object.entries(userSessions)) {
          map.set(name, sess);
          restored++;
        }
        if (map.size > 0) this._sessions.set(parseInt(userId), map);
      }
      if (restored > 0) console.log(`Sessions restored: ${restored}`);
    } catch {} // file doesn't exist yet — OK
  }

  // Return sessions updated within the last `withinMs` ms, newest first.
  getRecent(userId, withinMs = 24 * 60 * 60 * 1000) {
    const userSessions = this._sessions.get(userId);
    if (!userSessions) return [];
    const cutoff = Date.now() - withinMs;
    return [...userSessions.entries()]
      .filter(([, s]) => !s.archived && s.lastMessageAt && s.lastMessageAt > cutoff)
      .sort((a, b) => b[1].lastMessageAt - a[1].lastMessageAt);
  }

  // Persist current sessions to disk.
  persist() {
    try {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
      const data = {};
      for (const [userId, userSessions] of this._sessions) {
        data[userId] = Object.fromEntries(userSessions);
      }
      fs.writeFileSync(PERSIST_FILE, JSON.stringify(data, null, 2));
    } catch (e) { console.error('sessions persist error:', e.message); }
  }

  // Register a new session and create a tmux shell for terminal access.
  // Does NOT invoke Claude — the caller (runner.js via runTask) handles that.
  async create(user, taskDescription) {
    const name = `s${user.id}-${Date.now()}`;
    const env = this.authManager.getSessionEnv();
    const summary = taskDescription.slice(0, 60).replace(/\n/g, ' ');

    fs.mkdirSync(user.workDir, { recursive: true });

    spawn('tmux', ['new-session', '-d', '-s', name, '-x', '220', '-y', '50',
      '-c', user.workDir,
    ], { env });

    if (!this._sessions.has(user.id)) this._sessions.set(user.id, new Map());
    this._sessions.get(user.id).set(name, {
      taskDescription,
      summary,
      createdAt: Date.now(),
      archived: false,
    });
    this.persist();

    return name;
  }

  // Send a follow-up message to an existing tmux session.
  continue(user, sessionName, message) {
    if (!this._hasSession(sessionName)) {
      throw new Error(`Сессия ${sessionName} уже завершена. Начни новую.`);
    }
    const followFile = `/tmp/${sessionName}-follow-${Date.now()}.txt`;
    fs.writeFileSync(followFile, message);
    this._tmux(sessionName, `# User: ${message.replace(/\n/g, ' ').slice(0, 100)}`);
    this._tmux(sessionName, message);
  }

  archive(userId, sessionName) {
    const userSessions = this._sessions.get(userId);
    if (!userSessions?.has(sessionName)) return false;
    try { execSync(`tmux kill-session -t ${sessionName} 2>/dev/null`); } catch {}
    const iv = this._watchIntervals.get(sessionName);
    if (iv) { clearInterval(iv); this._watchIntervals.delete(sessionName); }
    userSessions.delete(sessionName);
    this.persist();
    return true;
  }

  setUserRef(user) { this._userRefs.set(user.id, user); }

  list(userId) {
    const userSessions = this._sessions.get(userId);
    if (!userSessions) return [];
    return [...userSessions.entries()].filter(([, s]) => !s.archived);
  }

  listAll() {
    const result = [];
    for (const [userId, userSessions] of this._sessions) {
      for (const [name, s] of userSessions) {
        result.push([name, { ...s, userId }]);
      }
    }
    return result;
  }

  async restartAll(userId) {
    const userSessions = this._sessions.get(userId);
    if (!userSessions) return;
    const tasks = [...userSessions.values()].map(s => s.taskDescription);
    for (const name of userSessions.keys()) {
      try { execSync(`tmux kill-session -t ${name} 2>/dev/null`); } catch {}
      const iv = this._watchIntervals.get(name);
      if (iv) { clearInterval(iv); this._watchIntervals.delete(name); }
    }
    userSessions.clear();
    const user = this._userRefs.get(userId);
    if (!user) return;
    for (const task of tasks) {
      await this._sleep(500);
      await this.create(user, task);
    }
  }

  // ── private ─────────────────────────────────────────────────────────────────

  _hasSession(name) {
    try { execSync(`tmux has-session -t ${name} 2>/dev/null`); return true; } catch { return false; }
  }

  _watchSession(name, user) {
    spawn('tmux', ['pipe-pane', '-t', name, '-o', `cat >> /tmp/${name}.log`]);
    const interval = setInterval(async () => {
      try {
        const log = fs.readFileSync(`/tmp/${name}.log`, 'utf8');
        if (AUTH_FAIL_RE.test(log)) {
          clearInterval(interval);
          this._watchIntervals.delete(name);
          await this.authManager.handleAuthFailure(name);
        }
      } catch {}
    }, 5000);
    this._watchIntervals.set(name, interval);
  }

  _tmux(session, cmd) {
    execSync(`tmux send-keys -t ${session} ${JSON.stringify(cmd)} Enter`);
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = { SessionManager };
