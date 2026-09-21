import { describe, it, expect } from 'vitest';
import {
  isBotMention,
  isReplyToBot,
  isAddressedToBot,
  stripBotMention,
  hasContent,
  shouldHandleAmbient,
  groupDisposition,
} from '../src/group-routing.js';

const BOT = 'super_personal_assistant_bot';

// These tests are the SPEC for docs/GROUP-TRIGGER-MATRIX.md — the group trigger
// decision used to live untested inline in dispatchInner and drifted into the
// "answers audio in large groups" bug. They pin the corrected matrix.

describe('mention detection', () => {
  it('matches @bot in text', () => {
    expect(isBotMention({ text: `эй @${BOT} глянь` }, BOT)).toBe(true);
  });
  it('matches @bot in a photo/doc CAPTION (was ignored → mention in big group missed)', () => {
    expect(isBotMention({ caption: `@${BOT} посмотри фото`, photo: [{}] }, BOT)).toBe(true);
  });
  it('is case-insensitive (user typed a different case)', () => {
    expect(isBotMention({ text: `@Super_Personal_Assistant_Bot привет` }, BOT)).toBe(true);
  });
  it('no false positive without the mention', () => {
    expect(isBotMention({ text: 'обычное сообщение' }, BOT)).toBe(false);
  });
});

describe('reply-to-bot detection', () => {
  it('matches a reply to the bot (case-insensitive)', () => {
    expect(isReplyToBot({ reply_to_message: { from: { username: BOT.toUpperCase() } } }, BOT)).toBe(true);
  });
  it('does not match a reply to another user', () => {
    expect(isReplyToBot({ reply_to_message: { from: { username: 'someone' } } }, BOT)).toBe(false);
  });
  it('does not match a plain message', () => {
    expect(isReplyToBot({ text: 'hi' }, BOT)).toBe(false);
  });
});

describe('stripBotMention', () => {
  it('removes the mention case-insensitively and trims', () => {
    expect(stripBotMention(`@${BOT} сделай отчёт`, BOT)).toBe('сделай отчёт');
    expect(stripBotMention(`@Super_Personal_Assistant_Bot go`, BOT)).toBe('go');
  });
  it('leaves plain text untouched', () => {
    expect(stripBotMention('просто текст', BOT)).toBe('просто текст');
  });
});

describe('shouldHandleAmbient — the gate that had the audio bug', () => {
  it('reacts in a 2-member group (bot + 1 human)', () => {
    expect(shouldHandleAmbient({ memberCount: 2 })).toBe(true);
  });
  it('ignores TEXT in a large group with all-msg off/unset', () => {
    expect(shouldHandleAmbient({ memberCount: 50 })).toBe(false);
    expect(shouldHandleAmbient({ memberCount: 50, allMsgMode: false })).toBe(false);
  });
  it('reacts to everything when allMsgMode is ON regardless of size', () => {
    expect(shouldHandleAmbient({ memberCount: 500, allMsgMode: true })).toBe(true);
  });
  it('fails closed (ignore) when member count is unknown', () => {
    expect(shouldHandleAmbient({})).toBe(false);
    expect(shouldHandleAmbient({ memberCount: null })).toBe(false);
  });
});

describe('groupDisposition — full matrix', () => {
  it('slash command → command', () => {
    expect(groupDisposition({ text: `/start@${BOT}` }, { botUsername: BOT, memberCount: 99 }))
      .toMatchObject({ action: 'command' });
  });

  it('mention → shared intake, even in a huge group', () => {
    expect(groupDisposition({ text: `@${BOT} что по задаче?` }, { botUsername: BOT, memberCount: 500 }))
      .toMatchObject({ action: 'accumulate', cleanText: 'что по задаче?' });
  });

  it('reply-to-bot → shared intake', () => {
    expect(groupDisposition(
      { text: 'да', reply_to_message: { from: { username: BOT } } },
      { botUsername: BOT, memberCount: 500 },
    )).toMatchObject({ action: 'accumulate' });
  });

  it('AUDIO BUG #4: ambient voice in a large group with all-msg off/unset → IGNORE', () => {
    // Pre-fix this returned react (voice bypassed the member gate). Locked closed now.
    expect(groupDisposition({ voice: { file_id: 'v1' } }, { botUsername: BOT, memberCount: 50 }))
      .toMatchObject({ action: 'ignore' });
    expect(groupDisposition({ audio: { file_id: 'a1' } }, { botUsername: BOT, memberCount: 50, allMsgMode: false }))
      .toMatchObject({ action: 'ignore' });
  });

  it('ambient voice in a 2-member group → accumulate (small group reacts to all)', () => {
    expect(groupDisposition({ voice: { file_id: 'v1' } }, { botUsername: BOT, memberCount: 2 }))
      .toMatchObject({ action: 'accumulate' });
  });

  it('ambient text in a 2-member group → accumulate', () => {
    expect(groupDisposition({ text: 'мысль' }, { botUsername: BOT, memberCount: 2 }))
      .toMatchObject({ action: 'accumulate', cleanText: 'мысль' });
  });

  it('ambient text in a large group with all-msg off → ignore', () => {
    expect(groupDisposition({ text: 'болтовня' }, { botUsername: BOT, memberCount: 50 }))
      .toMatchObject({ action: 'ignore' });
  });

  it('ambient anything with allMsgMode ON → accumulate regardless of size', () => {
    expect(groupDisposition({ audio: { file_id: 'a' } }, { botUsername: BOT, memberCount: 500, allMsgMode: true }))
      .toMatchObject({ action: 'accumulate' });
  });

  it('empty/no-content ambient → ignore', () => {
    expect(groupDisposition({}, { botUsername: BOT, memberCount: 2 }))
      .toMatchObject({ action: 'ignore' });
  });
});
