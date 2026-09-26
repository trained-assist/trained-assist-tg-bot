import { describe, expect, it } from 'vitest';
import { assembleInput } from '../src/input-assembly.js';

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