import { describe, expect, it } from 'vitest';
import { assembleInput, renderSnapshotDocument, runInputTaskId } from '../src/input-assembly.js';

const voiceItem = (overrides = {}) => ({
  text: '',
  msg: {
    voice: { file_id: 'v1' },
    transcript: 'мой голос',
    fileRef: { id: 'a1', name: 'audio.ogg', mime: 'audio/ogg' },
    transcriptRef: { id: 't1', name: 'transcript.txt', mime: 'text/plain; charset=utf-8' },
    ...overrides,
  },
});
const docItem = { text: '', msg: { document: { file_id: 'd1' }, fileRef: { id: 'd1', name: 'report.pdf', mime: 'application/pdf' } } };

describe('input-assembly token compressor', () => {
  it('transcribed voice: replaces the raw "Вложение 1: audio.ogg" line with a compact [голосовое] marker', () => {
    const { task } = assembleInput([voiceItem()]);
    expect(task).toContain('мой голос');
    expect(task).toContain('[голосовое]');
    expect(task).not.toContain('Вложение 1: audio.ogg');
  });

  it('transcribed voice: marks the raw audio ref note:false so the agent skips its file-saved note', () => {
    const { fileRefs } = assembleInput([voiceItem()]);
    const audio = fileRefs.find(r => r.name === 'audio.ogg');
    const transcript = fileRefs.find(r => r.name === 'transcript.txt');
    expect(audio.note).toBe(false);
    expect(transcript.note).toBeUndefined();
  });

  it('non-transcribed document keeps the Вложение N line and an unmarked ref', () => {
    const { task, fileRefs } = assembleInput([docItem]);
    expect(task).toContain('Вложение 1: report.pdf');
    expect(fileRefs[0].note).toBeUndefined();
  });

  it('plain text message is untouched', () => {
    const { task, fileRefs } = assembleInput([{ text: 'просто текст', msg: { text: 'просто текст' } }]);
    expect(task).toBe('[Сообщение 1]\nпросто текст');
    expect(fileRefs).toHaveLength(0);
  });
});

describe('renderSnapshotDocument — файл input = текст задачи as-is, без комментариев', () => {
  // Replaces the 26.09 «truthfulness note» test: the owner (29.09) ruled that
  // explanations inside the input file («модель получает сверх…», «вход N
  // токенов», file list) hide the real input. The file is the input verbatim;
  // context goes only to the Telegram caption.
  it('snapshot: document is exactly the task that went to the agent', () => {
    const input = {
      state: 'snapshot',
      id: 'tg-abc',
      items: [{ text: '', msg: { voice: { file_id: 'v1' }, transcript: 'мой голос',
        fileRef: { id: 'a1', name: 'audio.ogg' } }, mediaPending: false }],
      body: { task: '[Сообщение 1]\nмой голос\n[голосовое]',
        fileRefs: [{ id: 'a1', name: 'audio.ogg' }, { id: 't1', name: 'transcript.txt' }] },
    };
    expect(renderSnapshotDocument(input)).toBe('[Сообщение 1]\nмой голос\n[голосовое]');
  });

  it('draft: document is exactly the assembled task, no heading', () => {
    expect(renderSnapshotDocument({ items: [{ text: 'a', msg: { text: 'a' } }], task: 'a', pending: false })).toBe('a');
  });
});

describe('runInputTaskId — mirrors the agent /run taskId derivation', () => {
  it('default audience → username-requestId', () => {
    expect(runInputTaskId({ username: 'vova', audience: 'default', requestId: 'msg-1-2' })).toBe('vova-msg-1-2');
  });
  it('scoped audience → username-audience-requestId', () => {
    expect(runInputTaskId({ username: 'vova', audience: 'recruiter', requestId: 'msg-1-2' })).toBe('vova-recruiter-msg-1-2');
  });
  it('missing/invalid requestId or username → null (no agent lookup, keep gateway view)', () => {
    expect(runInputTaskId({ username: 'vova', audience: 'default' })).toBeNull();
    expect(runInputTaskId({ username: 'vova', audience: 'default', requestId: 'a/b' })).toBeNull();
    expect(runInputTaskId({ username: '../x', audience: 'default', requestId: 'm1' })).toBeNull();
    expect(runInputTaskId(null)).toBeNull();
  });
});
