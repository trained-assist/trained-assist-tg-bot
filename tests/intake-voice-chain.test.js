import { describe, it, expect, vi, beforeEach } from 'vitest';

// END-TO-END GAP PROOF — voice through the REAL accumulator chain.
//
// The owner's complaint: fixes "pass tests" but voice still doesn't reach the
// agent in a group. Reason = a test-seam blind spot. Every existing voice test
// mocks the seam next to the thing it checks:
//   • intake-buffer.test.js   — mocks handleMessage → never transcribes
//   • intake-group-uniform    — mocks the DO stub → never dispatches
//   • intake-media-content    — hand-crafts the buffered msg → skips _dispatch
// So NOTHING drives the full trip a real group voice takes:
//   append(voice) → IntakeBuffer._dispatch → coalesce → REAL handleMessage →
//   Deepgram (mocked) → runTask(agent).
//
// These tests drive the REAL IntakeBuffer with a fake DO storage and a mocked
// Deepgram endpoint. Case 1 (single voice) should PASS — proving the happy path
// is genuinely wired end-to-end. Case 2 (two voices) currently FAILS — exposing
// that _dispatch keeps only the LAST message's .voice, so every earlier voice's
// audio is dropped (its coalesced "voice:<id>" tag is stripped as media noise).

const runTask = vi.fn();
const getProjectDecision = vi.fn();
const getSessions = vi.fn();
const classifyMessage = vi.fn();
const classifyAgentError = vi.fn();
const sendMessage = vi.fn();
const sendDocument = vi.fn();
const sendMessageWithKeyboard = vi.fn();
const editMessage = vi.fn();
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
  editMessage: (...a) => editMessage(...a),
}));
vi.mock('../src/handlers/commands.js', () => ({ renderSessionList: () => ({ text: '', buttons: [] }) }));

import { IntakeBuffer } from '../src/intake-buffer.js';

const AUDIO_BYTES = new Uint8Array([1, 2, 3, 4, 5]).buffer;
let getFileIds = [];
let deepgramCalls = 0;

// Minimal Durable Object storage: a Map + no-op alarms. Serialisation isn't
// needed here — the test appends sequentially.
function makeState() {
  const store = new Map();
  return {
    storage: {
      get: async (k) => store.get(k),
      put: async (k, v) => void store.set(k, v),
      delete: async (k) => void store.delete(k),
      setAlarm: async () => {},
      deleteAlarm: async () => {},
    },
  };
}

const env = {
  BOT_TOKEN: 't',
  DEEPGRAM_API_KEY: 'dg',
  TELEGRAM_API_URL: 'https://api.telegram.org',
  INTAKE_DEBOUNCE: 'on',
};

function voiceMsg(fileId, chatId = -5501536471) {
  return { chat: { id: chatId, type: 'supergroup' }, voice: { file_id: fileId } };
}

async function append(buf, msg, flush = false) {
  await buf.fetch(new Request('https://intake/append', {
    method: 'POST',
    body: JSON.stringify({ text: msg.text || '', msg, flush }),
  }));
  // Let the dynamic import() + awaited handleMessage inside _dispatch settle.
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  getFileIds = [];
  deepgramCalls = 0;
  getSession.mockResolvedValue({ username: 'u', lastSessionId: 's-1', lastMessageAt: Date.now() });
  getProjectDecision.mockResolvedValue({ action: 'auto' });
  runTask.mockResolvedValue({ pinnedMsgId: null });
  sendMessage.mockResolvedValue({ ok: true, result: { message_id: 10 } });
  sendMessageWithKeyboard.mockResolvedValue({ ok: true, result: { message_id: 11 } });
  editMessage.mockResolvedValue({ ok: true, result: { message_id: 11 } });
  setSession.mockResolvedValue();
  globalThis.fetch = vi.fn(async (url) => {
    const u = String(url);
    const m = u.match(/getFile\?file_id=([^&]+)/);
    if (m) {
      getFileIds.push(m[1]);
      return new Response(JSON.stringify({ ok: true, result: { file_path: `voices/${m[1]}.ogg` } }));
    }
    if (u.includes('deepgram.com')) {
      deepgramCalls++;
      const idx = deepgramCalls; // distinct text per call so we can assert both survive
      return new Response(JSON.stringify({
        results: { channels: [{ alternatives: [{ transcript: `голос номер ${idx} дошёл до агента`, confidence: 0.9 }] }] },
      }));
    }
    return new Response(AUDIO_BYTES); // file download
  });
});

describe('a group voice message reaches the agent through the accumulator', () => {
  it('SINGLE VOICE: append → _dispatch → transcribe → agent task carries the transcript', async () => {
    const state = makeState();
    const buf = new IntakeBuffer(state, env);
    await append(buf, voiceMsg('V1'), true); // force-launch this one voice

    expect(getFileIds).toContain('V1');              // the audio was actually fetched
    expect(runTask).toHaveBeenCalledTimes(1);        // the agent was invoked
    expect(runTask.mock.calls[0][1].task).toContain('голос номер 1 дошёл до агента');
    expect(runTask.mock.calls[0][1].task).not.toMatch(/^voice:/); // not the raw tag
    expect(deepgramCalls).toBe(1);                   // transcribed exactly once
  });

  it('TWO VOICES: both voices must be transcribed — not just the last (multi-voice loss)', async () => {
    const state = makeState();
    const buf = new IntakeBuffer(state, env);
    await append(buf, voiceMsg('V1'), false); // accumulate
    await append(buf, voiceMsg('V2'), true);  // launch the pair

    // The audio of BOTH voices reached Deepgram, each transcribed exactly once
    // (no double-transcription), and both transcripts survive into the launch task.
    expect(getFileIds).toContain('V1');
    expect(getFileIds).toContain('V2');
    expect(deepgramCalls).toBe(2);                    // once per voice, not 3
    expect(runTask).toHaveBeenCalledTimes(1);
    const task = runTask.mock.calls[0][1].task;
    expect(task).toContain('голос номер 1 дошёл до агента');
    expect(task).toContain('голос номер 2 дошёл до агента');
  });
});
