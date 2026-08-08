import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const originalSessionStoreDir = process.env.SESSION_STORE_DIR;
let stateDir = '';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
} as any;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-controlled-restart-'));
  process.env.SESSION_STORE_DIR = stateDir;
  vi.clearAllMocks();
});

afterEach(async () => {
  const notice = await import('../src/bridge/restart-notice.js');
  notice.clearRestartBreadcrumb();
  if (originalSessionStoreDir === undefined) delete process.env.SESSION_STORE_DIR;
  else process.env.SESSION_STORE_DIR = originalSessionStoreDir;
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function makeBot(name: string, chatId: string, startedAt: number, platform: 'feishu' | 'telegram' = 'feishu') {
  const sender = {
    sendTextNotice: vi.fn().mockResolvedValue(undefined),
    updateCard: vi.fn().mockResolvedValue(true),
  };
  const bridge = {
    beginRestartQuiesce: vi.fn(),
    cancelRestartQuiesce: vi.fn(),
    getRestartTaskSnapshots: vi.fn().mockReturnValue([{
      botName: name,
      chatId,
      messageId: `msg-${name}`,
      userPrompt: `work for ${name}`,
      startedAt,
      source: 'chat',
      sendCards: true,
      cardState: {
        status: 'running',
        userPrompt: `work for ${name}`,
        responseText: `partial ${name}`,
        toolCalls: [],
      },
    }]),
  };
  return { name, platform, sender, bridge, config: {} } as any;
}

function makeRegistry(bots: any[]) {
  return {
    listRegistered: vi.fn().mockReturnValue(bots),
    getByPlatform: vi.fn((name: string, platform: string) => bots.find((bot) => bot.name === name && bot.platform === platform)),
    get: vi.fn((name: string) => bots.find((bot) => bot.name === name)),
  } as any;
}

describe('controlled restart coordination', () => {
  it('quiesces every bot, checkpoints all active chats, and uses each bot sender for prepare notices', async () => {
    const admin = makeBot('admin', 'chat-admin', 200);
    const pm = makeBot('pm-codex', 'chat-pm', 100);
    const registry = makeRegistry([admin, pm]);
    const { prepareControlledRestart, readControlledRestartPlan } = await import('../src/bridge/restart-coordinator.js');

    const plan = await prepareControlledRestart({
      registry,
      logger,
      request: {
        requestId: 'restart-multi-bot-1',
        requesterBot: 'admin',
        requesterChat: 'chat-admin',
        reason: 'upgrade runtime',
        resume: true,
      },
      now: 1_000,
    });

    expect(plan.status).toBe('prepared');
    expect(plan.participants.map((participant) => participant.botName)).toEqual(['pm-codex', 'admin']);
    expect(admin.bridge.beginRestartQuiesce).toHaveBeenCalledWith('restart-multi-bot-1');
    expect(pm.bridge.beginRestartQuiesce).toHaveBeenCalledWith('restart-multi-bot-1');
    expect(admin.sender.sendTextNotice).toHaveBeenCalledWith(
      'chat-admin', 'MetaBot Restart Preparing', expect.stringContaining('upgrade runtime'), 'orange',
    );
    expect(pm.sender.sendTextNotice).toHaveBeenCalledWith(
      'chat-pm', 'MetaBot Restart Preparing', expect.stringContaining('continuation'), 'orange',
    );
    expect(readControlledRestartPlan()).toMatchObject({
      requestId: 'restart-multi-bot-1',
      status: 'prepared',
      participants: [{ botName: 'pm-codex' }, { botName: 'admin' }],
    });
  });

  it('cancels prepare and releases every bot when one affected chat cannot be notified', async () => {
    const admin = makeBot('admin', 'chat-admin', 100);
    const pm = makeBot('pm-codex', 'chat-pm', 200);
    pm.sender.sendTextNotice.mockRejectedValueOnce(new Error('send failed'));
    const registry = makeRegistry([admin, pm]);
    const { prepareControlledRestart, readControlledRestartPlan } = await import('../src/bridge/restart-coordinator.js');

    await expect(prepareControlledRestart({
      registry,
      logger,
      request: { requestId: 'restart-notice-fail' },
    })).rejects.toThrow(/could not notify 1 affected chat/);

    expect(readControlledRestartPlan()?.status).toBe('cancelled');
    expect(admin.bridge.cancelRestartQuiesce).toHaveBeenCalledWith('restart-notice-fail');
    expect(pm.bridge.cancelRestartQuiesce).toHaveBeenCalledWith('restart-notice-fail');
  });

  it('does not replay work that finishes while prepare notices are being delivered', async () => {
    const admin = makeBot('admin', 'chat-admin', 100);
    admin.sender.sendTextNotice.mockImplementationOnce(async () => {
      admin.bridge.getRestartTaskSnapshots.mockReturnValue([]);
    });
    const registry = makeRegistry([admin]);
    const coordinator = await import('../src/bridge/restart-coordinator.js');
    const notice = await import('../src/bridge/restart-notice.js');

    const plan = await coordinator.prepareControlledRestart({
      registry,
      logger,
      request: { requestId: 'restart-finished-during-prepare' },
    });

    expect(plan.participants[0]).toMatchObject({
      botName: 'admin',
      prepareNotice: 'delivered',
      wasActive: false,
    });
    fs.writeFileSync(path.join(stateDir, 'last-restart.json'), JSON.stringify({
      restartedAt: Math.floor(Date.now() / 1000),
      requestId: plan.requestId,
    }));
    notice.loadRestartBreadcrumb();
    const scheduleTask = vi.fn();
    await coordinator.recoverControlledRestartAfterStartup({
      registry,
      scheduler: { scheduleTask } as any,
      logger,
    });

    expect(scheduleTask).not.toHaveBeenCalled();
    expect(admin.sender.updateCard).not.toHaveBeenCalled();
    expect(admin.sender.sendTextNotice).toHaveBeenLastCalledWith(
      'chat-admin',
      'MetaBot Restart Complete',
      expect.stringContaining('No in-flight turn was recorded'),
      'green',
    );
  });

  it('sends completion from every bot and queues one durable continuation per interrupted chat', async () => {
    const admin = makeBot('admin', 'chat-admin', 100);
    const pm = makeBot('pm-codex', 'chat-pm', 200);
    const registry = makeRegistry([admin, pm]);
    const coordinator = await import('../src/bridge/restart-coordinator.js');
    const notice = await import('../src/bridge/restart-notice.js');

    await coordinator.prepareControlledRestart({
      registry,
      logger,
      request: { requestId: 'restart-recover-all', requesterBot: 'admin', requesterChat: 'chat-admin' },
    });
    fs.writeFileSync(path.join(stateDir, 'last-restart.json'), JSON.stringify({
      version: 1,
      restartedAt: Math.floor(Date.now() / 1000),
      requestId: 'restart-recover-all',
      resume: true,
    }));
    notice.loadRestartBreadcrumb();

    const scheduleTask = vi.fn((input: any) => ({ ...input, id: `task-${input.botName}` }));
    const recovered = await coordinator.recoverControlledRestartAfterStartup({
      registry,
      scheduler: { scheduleTask } as any,
      logger,
      now: 5_000,
    });

    expect(scheduleTask).toHaveBeenCalledTimes(2);
    expect(scheduleTask).toHaveBeenCalledWith(expect.objectContaining({
      botName: 'admin',
      chatId: 'chat-admin',
      dedupeKey: expect.stringContaining('restart-recover-all'),
      prompt: expect.stringContaining('work for admin'),
    }));
    expect(scheduleTask).toHaveBeenCalledWith(expect.objectContaining({ botName: 'pm-codex', chatId: 'chat-pm' }));
    expect(admin.sender.updateCard).toHaveBeenCalledWith('msg-admin', expect.objectContaining({
      status: 'complete', responseText: expect.stringContaining('partial admin'),
    }));
    expect(pm.sender.updateCard).toHaveBeenCalledWith('msg-pm-codex', expect.objectContaining({ status: 'complete' }));
    expect(admin.sender.sendTextNotice).toHaveBeenLastCalledWith(
      'chat-admin', 'MetaBot Restart Complete', expect.stringContaining('continuation turn was queued'), 'green',
    );
    expect(pm.sender.sendTextNotice).toHaveBeenLastCalledWith(
      'chat-pm', 'MetaBot Restart Complete', expect.stringContaining('continuation turn was queued'), 'green',
    );
    expect(recovered?.status).toBe('completed');
    expect(recovered?.participants.every((participant) => participant.continuationOutcome === 'scheduled')).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'last-restart.json'))).toBe(false);
  });

  it('reports an idle requester without scheduling a continuation', async () => {
    const admin = makeBot('admin', 'unrelated-active-chat', 100);
    admin.bridge.getRestartTaskSnapshots.mockReturnValue([]);
    const registry = makeRegistry([admin]);
    const coordinator = await import('../src/bridge/restart-coordinator.js');
    const notice = await import('../src/bridge/restart-notice.js');

    await coordinator.prepareControlledRestart({
      registry,
      logger,
      request: {
        requestId: 'restart-idle-requester',
        requesterBot: 'admin',
        requesterChat: 'chat-requester',
      },
    });
    fs.writeFileSync(path.join(stateDir, 'last-restart.json'), JSON.stringify({
      restartedAt: Math.floor(Date.now() / 1000),
      requestId: 'restart-idle-requester',
    }));
    notice.loadRestartBreadcrumb();
    const scheduleTask = vi.fn();

    await coordinator.recoverControlledRestartAfterStartup({
      registry,
      scheduler: { scheduleTask } as any,
      logger,
    });

    expect(scheduleTask).not.toHaveBeenCalled();
    expect(admin.sender.sendTextNotice).toHaveBeenLastCalledWith(
      'chat-requester',
      'MetaBot Restart Complete',
      expect.stringContaining('no continuation was needed'),
      'green',
    );
  });

  it('resumes non-card API work without sending notices to synthetic chat IDs', async () => {
    const admin = makeBot('admin', 'agent-bus:request-1', 100);
    admin.bridge.getRestartTaskSnapshots.mockReturnValue([{
      botName: 'admin',
      chatId: 'agent-bus:request-1',
      userPrompt: 'delegate this task',
      startedAt: 100,
      source: 'api',
      sendCards: false,
      queuedPrompts: ['then report the result'],
    }]);
    const registry = makeRegistry([admin]);
    const coordinator = await import('../src/bridge/restart-coordinator.js');

    const prepared = await coordinator.prepareControlledRestart({
      registry,
      logger,
      request: { requestId: 'restart-api-no-cards' },
    });
    expect(prepared.participants[0]?.prepareNotice).toBe('skipped');
    expect(admin.sender.sendTextNotice).not.toHaveBeenCalled();

    const scheduleTask = vi.fn((input: any) => ({ ...input, id: 'task-agent-bus' }));

    // A fresh prepared plan is recoverable even if the CLI/process dies in the
    // narrow window before it can persist last-restart.json.
    const recovered = await coordinator.recoverControlledRestartAfterStartup({
      registry,
      scheduler: { scheduleTask } as any,
      logger,
    });

    expect(scheduleTask).toHaveBeenCalledWith(expect.objectContaining({
      botName: 'admin',
      chatId: 'agent-bus:request-1',
      sendCards: false,
      prompt: expect.stringContaining('then report the result'),
    }));
    expect(admin.sender.sendTextNotice).not.toHaveBeenCalled();
    expect(admin.sender.updateCard).not.toHaveBeenCalled();
    expect(recovered?.participants[0]).toMatchObject({
      completionNotice: 'skipped',
      continuationOutcome: 'scheduled',
    });
  });

  it('retains the durable handoff when continuation scheduling fails', async () => {
    const admin = makeBot('admin', 'chat-admin', 100);
    const registry = makeRegistry([admin]);
    const coordinator = await import('../src/bridge/restart-coordinator.js');

    await coordinator.prepareControlledRestart({
      registry,
      logger,
      request: { requestId: 'restart-retry-schedule' },
    });
    const scheduleTaskDurably = vi.fn(() => {
      throw new Error('durable scheduler unavailable');
    });

    const recovered = await coordinator.recoverControlledRestartAfterStartup({
      registry,
      scheduler: { scheduleTask: vi.fn(), scheduleTaskDurably } as any,
      logger,
    });

    expect(scheduleTaskDurably).toHaveBeenCalledOnce();
    expect(recovered).toMatchObject({
      status: 'prepared',
      participants: [{
        continuationOutcome: 'failed',
        completionNotice: 'delivered',
      }],
    });
    expect(recovered?.participants[0]?.recoveredAt).toBeUndefined();
    expect(coordinator.readControlledRestartPlan()?.status).toBe('prepared');
  });
});
