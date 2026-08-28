const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SESSIONS_DIR = '/home/vova/alesa-sessions';
const PERSIST_FILE = path.join(SESSIONS_DIR, 'sessions.json');

class SessionManager {
  constructor({ authManager, bot }) {
    this.authManager = authManager;
    this.bot = bot;
    this._sessions = new Map(); // userId → Map(sessionName → { taskDescription, summary, createdAt })
    this._userRefs = new Map();
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
  // Does NOT invoke Claude — runTask in runner.js handles that.
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

  archive(userId, sessionName) {
    const userSessions = this._sessions.get(userId);
    if (!userSessions?.has(sessionName)) return false;
    try { execSync(`tmux kill-session -t ${sessionName} 2>/dev/null`); } catch {}
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
}

module.exports = { SessionManager };
