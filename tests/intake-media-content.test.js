import { withUploads } from './helpers/uploads.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// GAP PROOF (media content loss on the buffered path).
//
// #66 part B made media ACCUMULATE (shouldDebounce buffers photo/voice/doc), and
// the invariant tests assert "does not launch". But nothing asserts what actually
// reaches the AGENT after the buffer is launched. With INTAKE_DEBOUNCE on (prod
// default) EVERY media message goes through the buffer, and IntakeBuffer._dispatch
// coalesces the item to a TAG STRING ("photo:<file_id>") which it puts on msg.text.
// handleMessage then takes the `if (text)` branch first and never downloads the
// file — so the agent receives the literal string "photo:AgAC…", not the image.
// Same for voice (never transcribed) and documents.
//
// These tests drive the REAL handleMessage with a stubbed Telegram download and a
// captured runTask. Control case = a direct (un-buffered) photo, which works. The
// buffered-shape cases encode the DESIRED behaviour and currently FAIL.

const runTask = vi.fn();
const getProjectDecision = vi.fn();
const getSessions = vi.fn();
const classifyMessage = vi.fn();
const classifyAgentError = vi.fn();
const sendMessage = vi.fn();
const sendDocument = vi.fn();
const sendMessageWithKeyboard = vi.fn();
const setSession = vi.fn();
const getSession = vi.fn();

vi.mock('../src/lib/agent-client.js', () => ({
  runTask: (...a) => runTask(...a),
  getSessions: (...a) => getSessions(...a),
  classifyMessage: (...a) => classifyMessage(...a),
  getProjectDecision: (...a) => getProjectDecision(...a),
  classifyAgentError: (...a) => classifyAgentError(...a),
}));
vi.mock('../src/lib/kv.js', () => ({
  getSession: (...a) => getSession(...a),
  setSession: (...a) => setSession(...a),
}));
vi.mock('../src/lib/telegram.js', () => ({
  sendMessage: (...a) => sendMessage(...a),
  sendDocument: (...a) => sendDocument(...a),
  sendMessageWithKeyboard: (...a) => sendMessageWithKeyboard(...a),
  editMessage: vi.fn(async () => ({ ok: true })),
  editMessageReplyMarkup: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../src/handlers/commands.js', () => ({ renderSessionList: () => ({ text: '', buttons: [] }) }));

import { handleMessage } from '../src/handlers/message.js';

const PHOTO_BYTES = new Uint8Array([1, 2, 3, 4, 5]).buffer;

beforeEach(() => {
  vi.clearAllMocks();
  // Recent session → resolveSessionRoute continues it (no picker, no getSessions).
  getSession.mockResolvedValue({
    username: 'u', lastSessionId: 's-1', lastMessageAt: Date.now(),
  });
  getProjectDecision.mockResolvedValue({ action: 'auto' });
  runTask.mockResolvedValue({ pinnedMsgId: null });
  sendMessage.mockResolvedValue({ ok: true, result: { message_id: 10 } });
  sendMessageWithKeyboard.mockResolvedValue({ ok: true, result: { message_id: 11 } });
  setSession.mockResolvedValue();
  // Stub Telegram getFile + file download (downloadTgFileBase64 / transcribeVoice)
  // and the Deepgram transcription endpoint.
  globalThis.fetch = withUploads(async (url) => {
    const u = String(url);
    if (u.includes('/getFile')) {
      return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/x.jpg' } }));
    }
    if (u.includes('deepgram.com')) {
      return new Response(JSON.stringify({
        results: { channels: [{ alternatives: [{ transcript: 'привет как дела', confidence: 0.9 }] }] },
      }));
    }
    return new Response(PHOTO_BYTES);
  });
});

const env = { BOT_TOKEN: 't', TELEGRAM_API_URL: 'https://api.telegram.org' };

describe('media reaches the agent as a file, not a tag string', () => {
  it('CONTROL: a direct photo (no buffer) is downloaded and passed as fileBase64', async () => {
    const msg = { chat: { id: 42 }, photo: [{ file_id: 'AgAC123' }], caption: 'посмотри' };
    await handleMessage(msg, env);
    expect(runTask).toHaveBeenCalledTimes(1);
    expect(runTask.mock.calls[0][1].fileRefs).toHaveLength(1);
    expect(runTask.mock.calls[0][1].fileBase64).toBeFalsy();
  });

  it('BUFFERED SHAPE: a photo carrying a coalesced "photo:<id>" text must STILL reach the agent as a file', async () => {
    // This is exactly what IntakeBuffer._dispatch produces: base msg keeps .photo,
    // but .text is overwritten with the coalesced tag string.
    const msg = { chat: { id: 42 }, photo: [{ file_id: 'AgAC123' }], text: 'photo:AgAC123' };
    await handleMessage(msg, env);
    expect(runTask).toHaveBeenCalledTimes(1);
    const arg = runTask.mock.calls[0][1];
    // DESIRED: the image bytes reached the agent.
    expect(arg.fileRefs).toHaveLength(1);
    expect(arg.fileRefs[0].size).toBe(5);
    // DESIRED: the agent's task is not the literal tag string.
    expect(arg.task).not.toBe('photo:AgAC123');
  });

  it('BUFFERED VOICE: a voice carrying a coalesced "voice:<id>" text must be TRANSCRIBED, not sent as a tag', async () => {
    // The headline case ("голос!"): idle voice → buffered → dispatch keeps .voice
    // but sets .text = "voice:<id>". Old code hit `if (text)` and sent the tag raw,
    // never transcribing. Now the voice branch runs first.
    const msg = { chat: { id: 42 }, voice: { file_id: 'Voice123' }, text: 'voice:Voice123' };
    await handleMessage(msg, env);
    expect(runTask).toHaveBeenCalledTimes(1);
    const arg = runTask.mock.calls[0][1];
    expect(arg.task).toContain('привет как дела');
    expect(arg.task).not.toBe('voice:Voice123');
  });

  // GAP PROOF: IntakeBuffer._dispatch calls handleMessage(msg, env, { mode: 'deep' }) —
  // «▶️ Запустить проработку» must always launch the resilient DEEP session (#530 §A).
  // Each media branch builds its own opts object for the inner handleText() call; it's
  // easy to forward isVoice/fileBase64 and forget `mode`, silently downgrading a
  // buffered launch to a one-shot. One assertion per branch pins this end-to-end.
  describe('mode:"deep" from the buffered launch reaches runTask for every media branch', () => {
    it('photo', async () => {
      const msg = { chat: { id: 42 }, photo: [{ file_id: 'AgAC123' }], text: 'photo:AgAC123' };
      await handleMessage(msg, env, { mode: 'deep' });
      expect(runTask.mock.calls[0][1].mode).toBe('deep');
    });

    it('voice', async () => {
      const msg = { chat: { id: 42 }, voice: { file_id: 'Voice123' }, text: 'voice:Voice123' };
      await handleMessage(msg, env, { mode: 'deep' });
      expect(runTask.mock.calls[0][1].mode).toBe('deep');
    });

    it('document', async () => {
      const msg = { chat: { id: 42 }, document: { file_id: 'Doc123', file_name: 'a.pdf' }, text: 'document:Doc123' };
      await handleMessage(msg, env, { mode: 'deep' });
      expect(runTask.mock.calls[0][1].mode).toBe('deep');
    });

    it('video', async () => {
      const msg = { chat: { id: 42 }, video: { file_id: 'Vid123', mime_type: 'video/mp4' }, text: 'video:Vid123' };
      await handleMessage(msg, env, { mode: 'deep' });
      expect(runTask.mock.calls[0][1].mode).toBe('deep');
    });
  });
});

describe('video messages are transcribed, not forwarded as raw bytes', () => {
  it('a native video message is sent to Deepgram and the transcript reaches the agent', async () => {
    const msg = { chat: { id: 42 }, video: { file_id: 'Vid123', mime_type: 'video/mp4' } };
    await handleMessage(msg, env);
    expect(runTask).toHaveBeenCalledTimes(1);
    const arg = runTask.mock.calls[0][1];
    expect(arg.task).toContain('привет как дела');
    expect(arg.fileBase64).toBeFalsy();
  });

  it('a video sent as a "file" (document with video/* mime_type) is also transcribed', async () => {
    const msg = { chat: { id: 42 }, document: { file_id: 'Doc999', file_name: 'clip.mov', mime_type: 'video/quicktime' } };
    await handleMessage(msg, env);
    expect(runTask).toHaveBeenCalledTimes(1);
    expect(runTask.mock.calls[0][1].task).toContain('привет как дела');
  });
});

describe('oversized media is rejected before hitting Telegram\'s getFile limit', () => {
  it('a >20MB video is refused with a friendly message and never reaches runTask', async () => {
    const msg = { chat: { id: 42 }, video: { file_id: 'Big1', mime_type: 'video/mp4', file_size: 900 * 1024 * 1024 } };
    await expect(handleMessage(msg, env)).rejects.toThrow('20 MB');
    expect(runTask).not.toHaveBeenCalled();
  });

  it('a >20MB document is refused the same way', async () => {
    const msg = { chat: { id: 42 }, document: { file_id: 'Big2', file_name: 'big.zip', file_size: 25 * 1024 * 1024 } };
    await expect(handleMessage(msg, env)).rejects.toThrow('20 MB');
    expect(runTask).not.toHaveBeenCalled();
  });

  it('a >20MB photo is refused the same way', async () => {
    const msg = { chat: { id: 42 }, photo: [{ file_id: 'Big3', file_size: 21 * 1024 * 1024 }] };
    await expect(handleMessage(msg, env)).rejects.toThrow('20 MB');
    expect(runTask).not.toHaveBeenCalled();
  });

  it('a video under 20MB is downloaded normally', async () => {
    const msg = { chat: { id: 42 }, video: { file_id: 'Small1', mime_type: 'video/mp4', file_size: 5 * 1024 * 1024 } };
    await handleMessage(msg, env);
    expect(runTask).toHaveBeenCalledTimes(1);
  });
});

// Real DO → real media handler → captured agent boundary.
import { IntakeBuffer } from '../src/intake-buffer.js';
async function launchBatch(messages) {
  const data = new Map();
  const state = { storage: {
    get: async k => structuredClone(data.get(k)),
    put: async (k, v) => data.set(k, structuredClone(v)),
    delete: async k => data.delete(k), setAlarm: async () => {}, deleteAlarm: async () => {},
  }};
  const intake = new IntakeBuffer(state, env);
  for (const msg of messages) await intake.fetch(new Request('https://intake/append', {
    method: 'POST', body: JSON.stringify({ msg, text: msg.text }),
  }));
  await intake.fetch(new Request('https://intake/flush', { method: 'POST' }));
  return data;
}

describe('complete accumulated batch at agent boundary', () => {
  it('five voices produce five transcripts in ONE deep task', async () => {
    let n = 0;
    const original = globalThis.fetch;
    globalThis.fetch = withUploads(async (url, opts) => String(url).includes('deepgram.com')
      ? new Response(JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: `вопрос ${++n}` }] }] } }))
      : original(url, opts));
    await launchBatch(Array.from({ length: 5 }, (_, i) => ({ chat: { id: 42 }, message_id: i + 1, voice: { file_id: `v${i}` } })));
    expect(runTask).toHaveBeenCalledTimes(1);
    const task = runTask.mock.calls[0][1];
    for (let i = 1; i <= 5; i++) expect(task.task).toContain(`вопрос ${i}`);
    expect(task.mode).toBe('deep');
    expect(task.task).not.toMatch(/voice:v/);
  });

  it.each(['private', 'supergroup'])('%s: voice reply, photo and text retain content and original session after selection changes', async (type) => {
    getSession.mockResolvedValue({ username: 'u', activeSessionId: 'different', lastSessionId: 'different', projectId: 'different-project', contextFromSession: 'unrelated-context' });
    await launchBatch([
      { chat: { id: 42, type }, message_id: 1, voice: { file_id: 'v1' }, reply_to_message: { message_id: 99 }, intakeRoute: { sessionId: 's-original', projectId: 'p-original', forceNew: false } },
      { chat: { id: 42, type }, message_id: 2, photo: [{ file_id: 'p1' }], caption: 'подпись скриншота' },
      { chat: { id: 42, type }, message_id: 3, text: 'последний вопрос' },
    ]);
    expect(runTask).toHaveBeenCalledTimes(1);
    const task = runTask.mock.calls[0][1];
    expect(task.task).toContain('привет как дела');
    expect(task.sessionId).toBe('s-original');
    expect(task.projectId).toBe('p-original');
    expect(task.forceNew).toBe(false);
    expect(task.contextFromSession).toBe(null);
    expect(task.task).toContain('подпись скриншота');
    expect(task.task).toContain('последний вопрос');
    expect(task.fileRefs).toHaveLength(3);
    expect(task.fileBase64).toBeFalsy();
  });

  it('a failed earlier transcription keeps the entire batch for retry and launches nothing', async () => {
    globalThis.fetch = withUploads(async () => new Response(JSON.stringify({ ok: false })));
    const data = await launchBatch([
      { chat: { id: 42 }, message_id: 1, voice: { file_id: 'bad' } },
      { chat: { id: 42 }, message_id: 2, text: 'последний вопрос' },
    ]);
    expect(runTask).not.toHaveBeenCalled();
    expect(data.get('retryBatch')).toHaveLength(2);
  });
});


it('two photos and a document arrive as separate durable refs, without an archive', async () => {
  await launchBatch([
    { chat: { id: 42 }, message_id: 1, photo: [{ file_id: 'p1' }] },
    { chat: { id: 42 }, message_id: 2, photo: [{ file_id: 'p2' }] },
    { chat: { id: 42 }, message_id: 3, document: { file_id: 'd1', file_name: 'report.txt' } },
    { chat: { id: 42 }, message_id: 4, text: 'проверь все файлы' },
  ]);
  expect(runTask).toHaveBeenCalledTimes(1);
  const arg = runTask.mock.calls[0][1];
  expect(arg.fileRefs.map(r => r.name)).toEqual(['photo.jpg', 'photo.jpg', 'report.txt']);
  expect(new Set(arg.fileRefs.map(r => r.id)).size).toBe(3);
  expect(arg.fileRefs.every(r => r.size === 5)).toBe(true);
  expect(arg.fileBase64).toBeFalsy();
  expect(arg.task).toContain('проверь все файлы');
});

// Collector is the only status bubble for an explicitly launched batch.
it('reuses collector status for a voice batch instead of leaving two launching bubbles', async () => {
  await handleMessage({ chat: { id: 42 }, intakeItems: [
    { msg: { voice: { file_id: 'voice' }, transcript: 'доработай задачу' } },
  ] }, env, { mode: 'deep', initialMsgId: 777 });
  expect(runTask.mock.calls[0][1]).toMatchObject({ initialMsgId: 777, mode: 'deep' });
  expect(sendMessage).not.toHaveBeenCalled();
});

it('failed screenshot persistence is tagged before dispatch and cannot launch text-only work', async () => {
  globalThis.fetch = vi.fn(async url => String(url).includes('/getFile')
    ? new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/x.jpg' } }))
    : String(url).includes('/intake-files') ? new Response('unavailable', { status: 503 }) : new Response(PHOTO_BYTES));
  await expect(handleMessage({ chat: { id: 42 }, message_id: 999,
    photo: [{ file_id: 'screenshot', file_unique_id: 'unique' }] },
    { BOT_TOKEN: 't', AGENT_URL: 'https://agent.example', AGENT_SECRET: 's' }))
    .rejects.toMatchObject({ code: 'INTAKE_PREPARATION_FAILED' });
  expect(runTask).not.toHaveBeenCalled();
});
