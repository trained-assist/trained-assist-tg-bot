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

describe('renderSnapshotDocument — компактный снапшот «что уходит модели»', () => {
  it('shows the assembled task (what the model receives) plus file names — not the raw metadata dump', () => {
    const input = {
      state: 'snapshot',
      id: 'tg-abc',
      items: [{ text: '', msg: { voice: { file_id: 'v1' }, transcript: 'мой голос',
        fileRef: { id: 'a1', name: 'audio.ogg' } }, mediaPending: false }],
      body: { task: '[Сообщение 1]\nмой голос\n[голосовое]',
        fileRefs: [{ id: 'a1', name: 'audio.ogg' }, { id: 't1', name: 'transcript.txt' }] },
    };
    const doc = renderSnapshotDocument(input, 'Вход запуска tg-abc (зафиксирован)');
    expect(doc).toContain('[Сообщение 1]\nмой голос\n[голосовое]');
    expect(doc).toContain('Файлы: audio.ogg, transcript.txt');
    expect(doc).not.toContain('"state"');
    expect(doc).not.toContain('"file_id"');
    expect(doc).not.toContain('Полный snapshot и метаданные');
    // Truthfulness: the snapshot must NOT pretend the 1-sentence task is the
    // whole model input — the model also gets the system prompt (role/persona),
    // MCP tool definitions and context sections, so the run footer's
    // «вход N токенов» is the total input (2026-09-26 owner caught this).
    expect(doc).toContain('Это только текст задачи');
    expect(doc).toContain('системный промпт');
    expect(doc).toContain('MCP-инструментов');
    expect(doc).toContain('ВЕСЬ вход модели');
  });

  it('deduplicates repeated file refs and handles a draft with no body', () => {
    const doc = renderSnapshotDocument(
      { items: [{ text: 'a', msg: { text: 'a' } }], task: 'a', pending: false },
      'Текущий input: 1 сообщений');
    expect(doc).toContain('Текущий input: 1 сообщений');
    expect(doc).toContain('\na');
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
