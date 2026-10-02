import { describe, it, expect } from 'vitest';
import { readTgSliceConfig } from '../src/sandbox-tg/config.js';
import { makeEnv } from './helpers/p11-helpers.js';
import { ControlPlaneClient } from '../src/sandbox-tg/control-plane-client.js';
import { profileForUpdate } from '../src/sandbox-tg/profile.js';
import { TelegramEmulator } from '../src/sandbox-tg/telegram-emulator.js';
import { FakeControlPlane } from '../src/sandbox-tg/fake-control-plane.js';
import { TgDeliveryOutbox, DELIVERY_STATUS } from '../src/sandbox-tg/delivery.js';
import { ConversationSession, MemoryConversationStore, ConversationNotFoundError } from '../src/sandbox-tg/conversation.js';
import { messageKey, BatchCollector, MemoryBatchStore, BATCH_STATUS, tooLargeMessage, isTooLarge, attachmentOf, launchButton, launchedButton } from '../src/sandbox-tg/batch.js';
import { logTg, createLogCollector } from '../src/sandbox-tg/log.js';
import { TELEGRAM_FILE_SIZE_LIMIT_BYTES } from '../src/sandbox-tg/contract.js';

describe('minimal import test', () => {
  it('config module loads', () => {
    const config = readTgSliceConfig(makeEnv({}));
    expect(config.profileId).toBe('profile-1');
  });
  it('all imports work', () => {
    expect(ControlPlaneClient).toBeTruthy();
    expect(TelegramEmulator).toBeTruthy();
    expect(FakeControlPlane).toBeTruthy();
    expect(TgDeliveryOutbox).toBeTruthy();
    expect(ConversationSession).toBeTruthy();
    expect(BatchCollector).toBeTruthy();
    expect(logTg).toBeTruthy();
    expect(TELEGRAM_FILE_SIZE_LIMIT_BYTES).toBe(20 * 1024 * 1024);
  });
});