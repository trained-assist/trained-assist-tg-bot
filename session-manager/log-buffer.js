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
  const sorted = [...tasks.entries()].sort((a, b) => a[1].lastActive - b[1].lastActive);
  // Prefer evicting finished tasks first
  for (const [id, t] of sorted) {
    if (!t.isRunning) { tasks.delete(id); if (tasks.size <= MAX_TASKS) return; }
  }
  // If all tasks are still running, evict oldest by lastActive to stay within limit
  for (const [id] of sorted) {
    tasks.delete(id);
    if (tasks.size <= MAX_TASKS) return;
  }
}

module.exports = { createTask, push, setDone, getState };
