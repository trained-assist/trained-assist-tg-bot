import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleMessage } from '../src/handlers/message.js';
import { handleCallbackQuery } from '../src/handlers/callbacks.js';
import { handleCommand } from '../src/handlers/commands.js';
import { getSession, setSession } from '../src/lib/kv.js';
import { getProjectDecision, runTask } from '../src/lib/agent-client.js';
import { sendMessageWithKeyboard } from '../src/lib/telegram.js';

vi.mock('../src/lib/agent-client.js', async original => ({
  ...await original(), getProjectDecision: vi.fn(), runTask: vi.fn().mockResolvedValue({}),
}));
vi.mock('../src/lib/telegram.js', async original => ({
  ...await original(), sendMessage: vi.fn().mockResolvedValue({ result: { message_id: 50 } }),
  sendMessageWithKeyboard: vi.fn(), editMessage: vi.fn().mockResolvedValue({ ok: true }),
  answerCallbackQuery: vi.fn().mockResolvedValue({ ok: true }),
}));
let env, mid;
const chatId = 42;
const projects = Array.from({ length: 9 }, (_, i) => ({ id: `p${i}`, name: `Project ${i}` }));
const message = text => ({ message_id: ++mid, chat: { id: chatId, type: 'private' }, text });
async function tap(data, id) {
  const session = await getSession(env.SESSIONS, chatId);
  await handleCallbackQuery({ id: `callback-${mid++}`, data, from: { id: chatId },
    message: { message_id: id || session.pendingProjectChoice?.messageId || 100, chat: { id: chatId } } }, env);
}
beforeEach(async () => {
  vi.clearAllMocks(); mid = 100;
  const map = new Map();
  env = { BOT_TOKEN: 'test', SESSIONS: {
    get: async (key, opts) => opts?.type === 'json' ? JSON.parse(map.get(key) || 'null') : map.get(key),
    put: async (key, val) => map.set(key, val), delete: async key => map.delete(key),
  } };
  getProjectDecision.mockResolvedValue({ action: 'ask', choices: projects });
  sendMessageWithKeyboard.mockImplementation(async () => ({ result: { message_id: ++mid } }));
  await setSession(env.SESSIONS, chatId, { username: 'owner', lastSessionId: 'old', lastMessageAt: Date.now(), projectId: 'old-project' });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ ok: true }) }));
});

describe('project selection through actual creation, message and callback handlers', () => {
  it.each(['nd:', 'nd:clean'])('%s shows choices immediately; stable IDs survive reordered lists', async data => {
    await tap(data);
    expect(runTask).not.toHaveBeenCalled();
    expect(sendMessageWithKeyboard.mock.calls.at(-1)[3].flat().some(b => b.callback_data === 'pc:0')).toBe(true);
    getProjectDecision.mockResolvedValue({ action: 'ask', choices: [...projects].reverse() });
    await tap('pc:0');
    await handleMessage(message('новая задача: текст'), env, { mode: 'deep' });
    expect(runTask).toHaveBeenCalledTimes(1);
    expect(runTask.mock.calls[0][1]).toMatchObject({ projectId: 'p0', forceNew: true, mode: 'deep', task: 'новая задача: текст' });
  });
  it('/new_dialog opens choices before a task exists', async () => {
    await handleCommand(message('/new_dialog'), env);
    expect((await getSession(env.SESSIONS, chatId)).pendingProjectChoice.choices).toHaveLength(9);
    expect(runTask).not.toHaveBeenCalled();
  });
  it('offers new project even with only one existing project', async () => {
    getProjectDecision.mockResolvedValue({ action: 'auto', choices: [projects[0]] });
    await tap('nd:'); await tap('pc:new');
    await handleMessage(message('Новая разработка'), env, { mode: 'deep' });
    expect(runTask.mock.calls[0][1]).toMatchObject({ projectId: null, newProjectName: 'Новая разработка', forceNew: true });
  });
  it('offers new project for an empty profile', async () => {
    getProjectDecision.mockResolvedValue({ action: 'create', choices: [] });
    await tap('nd:'); await tap('pc:new');
    expect((await getSession(env.SESSIONS, chatId)).pendingNewProject).toBe(true);
  });
  it('paginates all nine projects and selects the ninth', async () => {
    await tap('nd:'); await tap('pc:page:1'); await tap('pc:8');
    expect((await getSession(env.SESSIONS, chatId)).projectId).toBe('p8');
  });
  it('preserves mixed voice, text and file through deferred selection in deep mode', async () => {
    await setSession(env.SESSIONS, chatId, { username: 'owner' });
    await env.SESSIONS.put('attachment:1', JSON.stringify({ base64: 'aGVsbG8=' }));
    const input = { ...message('full batch'), intakeItems: [
      { text: 'Первый текст', msg: {} },
      { msg: { voice: { file_id: 'v' }, transcript: 'Вторая мысль' } },
      { text: 'Документ', msg: { document: { file_id: 'f', file_name: 'резюме.txt', mime_type: 'text/plain' }, attachmentKey: 'attachment:1' } },
    ] };
    await handleMessage(input, env, { mode: 'deep' });
    expect(runTask).not.toHaveBeenCalled();
    await tap('pc:1');
    expect(runTask).toHaveBeenCalledTimes(1);
    const payload = runTask.mock.calls[0][1];
    expect(payload).toMatchObject({ projectId: 'p1', mode: 'deep', fileBase64: 'aGVsbG8=', fileName: 'резюме.txt', context: '[voice-message]' });
    expect(payload.task).toContain('Первый текст'); expect(payload.task).toContain('Вторая мысль');
  });
  it('pending new-dialog menu forces selection even when old history is recent', async () => {
    await tap('nd:');
    await handleMessage(message('задача для нового диалога'), env, { mode: 'deep' });
    expect(runTask).not.toHaveBeenCalled();
    await tap('pc:0');
    expect(runTask.mock.calls[0][1]).toMatchObject({ forceNew: true, projectId: 'p0' });
  });
  it('keeps additional batches received while selection is pending', async () => {
    await tap('nd:');
    await handleMessage(message('one'), env, { mode: 'deep' });
    await handleMessage(message('two'), env, { mode: 'deep' });
    await tap('pc:0');
    const { task } = runTask.mock.calls[0][1];
    expect(task).toContain('one'); expect(task).toContain('two');
  });
  it('continuation keeps its project without asking', async () => {
    await handleMessage(message('продолжай'), env);
    expect(getProjectDecision).not.toHaveBeenCalled();
    expect(runTask.mock.calls[0][1]).toMatchObject({ sessionId: 'old', forceNew: false });
  });
  it('rejects replaced and already consumed menus', async () => {
    await tap('nd:'); const old = (await getSession(env.SESSIONS, chatId)).pendingProjectChoice.messageId;
    await tap('nd:'); await tap('pc:0', old);
    expect((await getSession(env.SESSIONS, chatId)).projectId).toBe('old-project');
    const current = (await getSession(env.SESSIONS, chatId)).pendingProjectChoice.messageId;
    await tap('pc:1', current); await tap('pc:2', current);
    expect((await getSession(env.SESSIONS, chatId)).projectId).toBe('p1');
  });
  it('expired choice cannot move a session', async () => {
    await tap('nd:'); const session = await getSession(env.SESSIONS, chatId);
    session.pendingProjectChoice.createdAt = Date.now() - 11 * 60 * 1000;
    await setSession(env.SESSIONS, chatId, session); await tap('pc:0');
    expect((await getSession(env.SESSIONS, chatId)).projectId).toBe('old-project');
  });
  it('new dialog with carried context still asks project and preserves source', async () => {
    await tap('sn:source'); await tap('pc:2'); await handleMessage(message('разбери'), env);
    expect(runTask.mock.calls[0][1]).toMatchObject({ projectId: 'p2', contextFromSession: 'source', forceNew: true });
  });
  it('retains the original batch after attachment preparation fails, then retries successfully', async () => {
    await setSession(env.SESSIONS, chatId, { username: 'owner' });
    const input = { ...message('file'), intakeItems: [{ msg: {
      document: { file_id: 'file', file_name: 'resume.txt', mime_type: 'text/plain' }, attachmentKey: 'file-cache',
    } }] };
    await handleMessage(input, env, { mode: 'deep' });
    await tap('pc:0');
    expect(runTask).not.toHaveBeenCalled();
    expect((await getSession(env.SESSIONS, chatId)).pendingProjectChoice.input.intakeItems).toHaveLength(1);
    await env.SESSIONS.put('file-cache', JSON.stringify({ base64: 'aGVsbG8=' }));
    await tap('pc:0');
    expect(runTask).toHaveBeenCalledTimes(1);
    expect(runTask.mock.calls[0][1]).toMatchObject({ projectId: 'p0', mode: 'deep', fileBase64: 'aGVsbG8=' });
  });
  it('new choice from session disambiguation also opens the project picker', async () => {
    const session = await getSession(env.SESSIONS, chatId);
    await setSession(env.SESSIONS, chatId, { ...session, pendingMessage: 'saved task', pendingMessageAt: Date.now() });
    await tap('sp:new');
    expect(runTask).not.toHaveBeenCalled();
    await tap('pc:3');
    expect(runTask.mock.calls[0][1]).toMatchObject({ projectId: 'p3', forceNew: true, task: 'saved task' });
  });

  it('switching to an existing dialog suspends the menu without losing its saved task', async () => {
    await tap('nd:'); await handleMessage(message('saved'), env, { mode: 'deep' });
    await tap('sc:existing'); await handleMessage(message('continue'), env);
    expect(runTask.mock.calls[0][1]).toMatchObject({ sessionId: 'existing', forceNew: false });
    await tap('nd:'); await tap('pc:0');
    expect(runTask.mock.calls[1][1]).toMatchObject({ projectId: 'p0', task: 'saved', mode: 'deep' });
  });

});
