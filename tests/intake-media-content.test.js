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
  setSession.mockResolvedValue();
  // Stub Telegram getFile + file download (downloadTgFileBase64 / transcribeVoice)
  // and the Deepgram transcription endpoint.
  globalThis.fetch = vi.fn(async (url) => {
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
    expect(runTask.mock.calls[0][1].fileBase64).toBeTruthy();
  });

  it('BUFFERED SHAPE: a photo carrying a coalesced "photo:<id>" text must STILL reach the agent as a file', async () => {
    // This is exactly what IntakeBuffer._dispatch produces: base msg keeps .photo,
    // but .text is overwritten with the coalesced tag string.
    const msg = { chat: { id: 42 }, photo: [{ file_id: 'AgAC123' }], text: 'photo:AgAC123' };
    await handleMessage(msg, env);
    expect(runTask).toHaveBeenCalledTimes(1);
    const arg = runTask.mock.calls[0][1];
    // DESIRED: the image bytes reached the agent.
    expect(arg.fileBase64).toBeTruthy();
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
  });
});
