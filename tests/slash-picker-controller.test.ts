import { describe, expect, it, vi } from 'vitest';
import { SlashPickerController } from '../src/bridge/slash-picker-controller.js';
import type { IncomingMessage } from '../src/types.js';

function message(text: string): IncomingMessage {
  return {
    messageId: 'message-1',
    chatId: 'chat-1',
    chatType: 'p2p',
    userId: 'user-1',
    text,
  };
}

function buildController() {
  let busy = false;
  const notices: Array<{ title: string; content: string; color?: string }> = [];
  const finalized: Array<{ messageId: string; state: Record<string, unknown> }> = [];
  const listSessionsForChat = vi.fn(async () => [{
    sessionId: 'abc12345-1111-1111-1111-111111111111',
    preview: 'Earlier task',
    lastActive: Date.now(),
    sizeBytes: 1,
    isCurrent: false,
  }]);
  const applyResume = vi.fn(async () => {});

  const controller = new SlashPickerController({
    config: {
      name: 'test',
      engine: 'claude',
      claude: {
        defaultWorkingDirectory: '/tmp',
        maxTurns: undefined,
        maxBudgetUsd: undefined,
        model: undefined,
        apiKey: undefined,
        outputsBaseDir: '/tmp/outputs',
        downloadsDir: '/tmp/downloads',
        backend: 'sdk',
      },
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as any,
    sender: {
      sendQuestionCard: vi.fn(async () => 'picker-card'),
      sendCard: vi.fn(async () => 'picker-card'),
      sendTextNotice: vi.fn(async (_chatId: string, title: string, content: string, color?: string) => {
        notices.push({ title, content, color });
      }),
    } as any,
    sessionManager: {
      getSession: vi.fn(() => ({
        engine: 'claude',
        workingDirectory: '/tmp',
      })),
    } as any,
    outputsManager: {} as any,
    listSessionsForChat,
    applyResume,
    finalizeQuestionCard: vi.fn(async (messageId, state) => {
      finalized.push({ messageId, state: state as unknown as Record<string, unknown> });
    }),
    handleMessage: vi.fn(async () => {}),
    isBusy: () => busy,
    prepareSessionForExecution: vi.fn(),
    runOneTurn: vi.fn(),
  });

  return {
    controller,
    listSessionsForChat,
    applyResume,
    notices,
    finalized,
    setBusy(value: boolean) {
      busy = value;
    },
  };
}

describe('SlashPickerController /resume busy guard', () => {
  it('refuses to open the picker while a task is active', async () => {
    const kit = buildController();
    kit.setBusy(true);

    await expect(kit.controller.tryOpen(message('/resume'))).resolves.toBe(true);

    expect(kit.listSessionsForChat).not.toHaveBeenCalled();
    expect(kit.applyResume).not.toHaveBeenCalled();
    expect(kit.notices).toEqual([{
      title: '⏳ Task In Progress',
      content: 'A task is running. Use `/stop` first, then `/resume`.',
      color: 'orange',
    }]);
  });

  it('cancels and clears a pending picker if a task starts before the reply', async () => {
    const kit = buildController();
    await expect(kit.controller.tryOpen(message('/resume'))).resolves.toBe(true);

    kit.setBusy(true);
    await expect(kit.controller.tryHandleReply(message('1'))).resolves.toBe(true);

    expect(kit.applyResume).not.toHaveBeenCalled();
    expect(kit.finalized).toHaveLength(1);
    expect(kit.finalized[0]).toMatchObject({
      messageId: 'picker-card',
      state: {
        status: 'error',
        userPrompt: '/resume',
        errorMessage: 'Task in progress',
      },
    });

    kit.setBusy(false);
    await expect(kit.controller.tryHandleReply(message('1'))).resolves.toBe(false);
  });
});
