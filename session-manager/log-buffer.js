const MAX_LINES = 300;
const MAX_TASKS = 50;

// taskId → { lines, isRunning, currentTask, startedAt, lastActive }
const tasks = new Map();

function createTask(taskId, taskText) {
  tasks.set(taskId, {
    lines: [],
    isRunning: true,
    currentTask: taskText,
    startedAt: Date.now(),
    lastActive: Date.now(),
  });
  _push(taskId, `▶ ${taskText}`);
  _cleanup();
}

function _push(taskId, text) {
  const task = tasks.get(taskId);
  if (!task) return;
  const now = new Date().toISOString().slice(11, 19);
  for (const line of text.split('\n')) {
    if (line.trim()) task.lines.push({ t: now, text: line });
  }
  if (task.lines.length > MAX_LINES) task.lines.splice(0, task.lines.length - MAX_LINES);
  task.lastActive = Date.now();
}

function push(taskId, text) { _push(taskId, text); }

function setDone(taskId) {
  const task = tasks.get(taskId);
  if (!task) return;
  const elapsed = ((Date.now() - task.startedAt) / 1000).toFixed(1);
  _push(taskId, `✓ Готово (${elapsed}с)`);
  task.isRunning = false;
  task.lastActive = Date.now();
}

function getState(taskId) {
  const task = tasks.get(taskId);
  if (!task) return null;
  return {
    isRunning: task.isRunning,
    currentTask: task.currentTask,
    startedAt: task.startedAt,
    lines: task.lines.slice(-200),
  };
}

function _cleanup() {
  if (tasks.size <= MAX_TASKS) return;
  // Sort by lastActive ascending (oldest first). Re-snapshot each pass so
  // deletions from the finished-task loop don't leave stale IDs in the running-task loop.
  const byAge = () => [...tasks.entries()].sort((a, b) => a[1].lastActive - b[1].lastActive);
  for (const [id, t] of byAge()) {
    if (!t.isRunning) { tasks.delete(id); if (tasks.size <= MAX_TASKS) return; }
  }
  for (const [id] of byAge()) {
    tasks.delete(id);
    if (tasks.size <= MAX_TASKS) return;
  }
}

module.exports = { createTask, push, setDone, getState };
