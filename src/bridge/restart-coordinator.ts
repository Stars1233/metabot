import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BotRegistry, RegisteredBot } from '../api/bot-registry.js';
import type { TaskScheduler } from '../scheduler/task-scheduler.js';
import type { CardState } from '../types.js';
import type { Logger } from '../utils/logger.js';
import {
  clearRestartBreadcrumb,
  getRestartBreadcrumb,
} from './restart-notice.js';

export interface RestartTaskSnapshot {
  botName: string;
  chatId: string;
  messageId?: string;
  userPrompt: string;
  startedAt: number;
  source: 'chat' | 'api';
  sendCards: boolean;
  cardState?: CardState;
  queuedPrompts?: string[];
}

export interface ControlledRestartRequest {
  requestId: string;
  requesterBot?: string;
  requesterChat?: string;
  source?: string;
  reason?: string;
  resume?: boolean;
  force?: boolean;
}

export interface ControlledRestartParticipant extends RestartTaskSnapshot {
  platform: RegisteredBot['platform'];
  wasActive: boolean;
  prepareNotice?: 'delivered' | 'failed' | 'skipped';
  completionNotice?: 'delivered' | 'failed' | 'skipped';
  continuationTaskId?: string;
  continuationOutcome?: 'scheduled' | 'skipped' | 'failed';
  recoveredAt?: number;
}

export interface ControlledRestartPlan {
  version: 1;
  requestId: string;
  status: 'preparing' | 'prepared' | 'cancelled' | 'completed';
  requesterBot?: string;
  requesterChat?: string;
  source: string;
  reason?: string;
  resume: boolean;
  force: boolean;
  participants: ControlledRestartParticipant[];
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  cancelledAt?: number;
}

export class RestartPreparationError extends Error {
  constructor(message: string, readonly statusCode = 409) {
    super(message);
    this.name = 'RestartPreparationError';
  }
}

const PLAN_FILENAME = 'controlled-restart.json';
const PLAN_TTL_MS = 24 * 60 * 60 * 1000;
const PREPARE_LEASE_MS = 2 * 60 * 1000;
const RECOVERY_WINDOW_MS = 15 * 60 * 1000;
const NOTICE_TIMEOUT_MS = 10_000;
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const preparationLeases = new Map<string, ReturnType<typeof setTimeout>>();

export async function prepareControlledRestart(input: {
  registry: BotRegistry;
  logger: Logger;
  request: ControlledRestartRequest;
  now?: number;
}): Promise<ControlledRestartPlan> {
  const now = input.now ?? Date.now();
  assertRequestId(input.request.requestId);
  if (!!input.request.requesterBot !== !!input.request.requesterChat) {
    throw new RestartPreparationError('requesterBot and requesterChat must be provided together', 400);
  }
  if (input.request.requesterBot && !input.registry.get(input.request.requesterBot)) {
    throw new RestartPreparationError(`Requester bot ${input.request.requesterBot} is not registered`, 400);
  }
  const existing = readControlledRestartPlan();
  if (existing?.requestId === input.request.requestId) {
    if (existing.status === 'prepared') {
      for (const bot of input.registry.listRegistered()) bot.bridge.beginRestartQuiesce(input.request.requestId);
      armPreparationLease(input.registry, input.logger, input.request.requestId);
      return existing;
    }
    if (existing.status === 'preparing') {
      throw new RestartPreparationError(`Restart request ${input.request.requestId} is still preparing; retry shortly`);
    }
    throw new RestartPreparationError(
      `Restart request ${input.request.requestId} is already ${existing.status}; use a new request ID`,
    );
  }
  if (existing && existing.status !== 'completed' && existing.status !== 'cancelled'
    && now - existing.updatedAt <= PLAN_TTL_MS) {
    throw new RestartPreparationError(`Restart ${existing.requestId} is already being prepared`);
  }

  const registered = input.registry.listRegistered();
  for (const bot of registered) bot.bridge.beginRestartQuiesce(input.request.requestId);

  try {
    const participants = collectParticipants(registered, input.request);
    let plan: ControlledRestartPlan = {
      version: 1,
      requestId: input.request.requestId,
      status: 'preparing',
      ...(input.request.requesterBot ? { requesterBot: input.request.requesterBot } : {}),
      ...(input.request.requesterChat ? { requesterChat: input.request.requesterChat } : {}),
      source: input.request.source?.trim() || 'cli',
      ...(input.request.reason?.trim() ? { reason: input.request.reason.trim().slice(0, 1000) } : {}),
      resume: input.request.resume !== false,
      force: input.request.force === true,
      participants,
      createdAt: now,
      updatedAt: now,
    };
    writeControlledRestartPlan(plan);

    const noticeResults = await Promise.all(participants.map(async (participant) => {
      if (!participant.sendCards) return 'skipped' as const;
      const bot = resolveParticipantBot(input.registry, participant);
      if (!bot) return 'failed' as const;
      try {
        await withTimeout(bot.sender.sendTextNotice(
          participant.chatId,
          'MetaBot Restart Preparing',
          buildPreparingNotice(plan, participant),
          'orange',
        ), NOTICE_TIMEOUT_MS, 'restart prepare notice timed out');
        return 'delivered' as const;
      } catch (error) {
        input.logger.warn(
          { err: error, requestId: plan.requestId, botName: participant.botName, chatId: participant.chatId },
          'Controlled restart prepare notice failed',
        );
        return 'failed' as const;
      }
    }));

    plan = {
      ...plan,
      status: 'prepared',
      participants: refreshParticipants(
        registered,
        plan.participants.map((participant, index) => ({
          ...participant,
          prepareNotice: noticeResults[index] ?? 'failed',
        })),
      ),
      updatedAt: input.now ?? Date.now(),
    };
    const failedNotices = plan.participants.filter((participant) => participant.prepareNotice === 'failed');
    if (failedNotices.length > 0 && !plan.force) {
      plan = {
        ...plan,
        status: 'cancelled',
        cancelledAt: input.now ?? Date.now(),
        updatedAt: input.now ?? Date.now(),
      };
      writeControlledRestartPlan(plan);
      releaseQuiesce(registered, plan.requestId);
      throw new RestartPreparationError(
        `Restart preparation could not notify ${failedNotices.length} affected chat(s); no restart was performed`,
      );
    }
    writeControlledRestartPlan(plan);
    armPreparationLease(input.registry, input.logger, plan.requestId);
    return plan;
  } catch (error) {
    releaseQuiesce(registered, input.request.requestId);
    throw error;
  }
}

export function cancelControlledRestart(input: {
  registry: BotRegistry;
  requestId: string;
  now?: number;
}): ControlledRestartPlan | undefined {
  assertRequestId(input.requestId);
  clearPreparationLease(input.requestId);
  const plan = readControlledRestartPlan();
  releaseQuiesce(input.registry.listRegistered(), input.requestId);
  if (!plan || plan.requestId !== input.requestId || plan.status === 'completed') return plan;
  const now = input.now ?? Date.now();
  const cancelled: ControlledRestartPlan = {
    ...plan,
    status: 'cancelled',
    cancelledAt: plan.cancelledAt ?? now,
    updatedAt: now,
  };
  writeControlledRestartPlan(cancelled);
  return cancelled;
}

export async function recoverControlledRestartAfterStartup(input: {
  registry: BotRegistry;
  scheduler: TaskScheduler;
  logger: Logger;
  now?: number;
}): Promise<ControlledRestartPlan | undefined> {
  const breadcrumb = getRestartBreadcrumb();
  const plan = readControlledRestartPlan();
  const now = input.now ?? Date.now();
  if (!breadcrumb) {
    // The CLI can be interrupted after prepare but before it writes its final
    // breadcrumb. A fresh prepared plan is sufficient proof that this process
    // replaced the quiesced one, so recover it instead of losing active work.
    if (!plan || plan.status !== 'prepared' || now - plan.updatedAt > RECOVERY_WINDOW_MS) {
      if (plan?.status === 'preparing' || plan?.status === 'prepared') {
        cancelControlledRestart({ registry: input.registry, requestId: plan.requestId, now });
      }
      return plan;
    }
  }
  if (breadcrumb && !breadcrumb.requestId) {
    // Legacy breadcrumb: keep its in-memory one-shot reminder, but do not leave
    // the file around to retrigger on a later cold start.
    clearRestartBreadcrumb();
    return undefined;
  }
  const requestId = breadcrumb?.requestId ?? plan?.requestId;
  if (!requestId || !plan || plan.requestId !== requestId || plan.status === 'cancelled') {
    if (breadcrumb) clearRestartBreadcrumb(breadcrumb.requestId);
    return plan;
  }
  clearPreparationLease(plan.requestId);
  if (plan.status === 'completed') {
    if (breadcrumb) clearRestartBreadcrumb(plan.requestId);
    return plan;
  }

  let next = plan;
  for (const participant of plan.participants) {
    if (participant.recoveredAt) continue;
    const now = input.now ?? Date.now();
    const bot = resolveParticipantBot(input.registry, participant);
    const continuationRequired = plan.resume
      && participant.wasActive
      && !isInternalExecutionChat(participant.chatId);
    let continuationOutcome: ControlledRestartParticipant['continuationOutcome'] = 'skipped';
    let continuationTaskId: string | undefined;
    let completionNotice: ControlledRestartParticipant['completionNotice'] = participant.sendCards ? 'failed' : 'skipped';

    if (!bot) {
      input.logger.warn(
        { requestId: plan.requestId, botName: participant.botName, platform: participant.platform },
        'Controlled restart recovery skipped because the bot is not registered',
      );
      continuationOutcome = 'failed';
    } else {
      if (continuationRequired) {
        try {
          const scheduleInput = {
            botName: participant.botName,
            chatId: participant.chatId,
            prompt: buildContinuationPrompt(plan, participant),
            delaySeconds: 2,
            sendCards: participant.sendCards,
            label: `Continue after restart ${plan.requestId}`,
            dedupeKey: continuationKey(plan.requestId, participant),
          };
          const durableScheduler = input.scheduler as TaskScheduler & {
            scheduleTaskDurably?: (value: typeof scheduleInput) => ReturnType<TaskScheduler['scheduleTask']>;
          };
          const task = durableScheduler.scheduleTaskDurably
            ? durableScheduler.scheduleTaskDurably(scheduleInput)
            : durableScheduler.scheduleTask(scheduleInput);
          continuationTaskId = task.id;
          continuationOutcome = 'scheduled';
        } catch (error) {
          continuationOutcome = 'failed';
          input.logger.error(
            { err: error, requestId: plan.requestId, botName: participant.botName, chatId: participant.chatId },
            'Controlled restart continuation scheduling failed',
          );
        }
      }

      if (participant.wasActive && participant.messageId) {
        try {
          await withTimeout(bot.sender.updateCard(
            participant.messageId,
            buildRecoveredCard(participant, continuationOutcome === 'scheduled', now),
          ), NOTICE_TIMEOUT_MS, 'restart interrupted-card update timed out');
        } catch (error) {
          input.logger.warn(
            { err: error, requestId: plan.requestId, botName: participant.botName, chatId: participant.chatId },
            'Controlled restart interrupted-card update failed',
          );
        }
      }

      if (participant.sendCards) try {
        await withTimeout(bot.sender.sendTextNotice(
          participant.chatId,
          'MetaBot Restart Complete',
          buildCompletionNotice(plan, participant, continuationOutcome),
          continuationOutcome === 'failed' ? 'red' : 'green',
        ), NOTICE_TIMEOUT_MS, 'restart completion notice timed out');
        completionNotice = 'delivered';
      } catch (error) {
        input.logger.warn(
          { err: error, requestId: plan.requestId, botName: participant.botName, chatId: participant.chatId },
          'Controlled restart completion notice failed',
        );
      }
    }

    next = {
      ...next,
      participants: next.participants.map((candidate) => participantKey(candidate) === participantKey(participant)
        ? {
          ...candidate,
          completionNotice,
          continuationOutcome,
          ...(continuationTaskId ? { continuationTaskId } : {}),
          ...(bot
            && (!continuationRequired || continuationOutcome === 'scheduled')
            && (!participant.sendCards || completionNotice === 'delivered')
            ? { recoveredAt: now }
            : {}),
        }
        : candidate),
      updatedAt: now,
    };
    writeControlledRestartPlan(next);
  }

  if (next.participants.some((participant) => !participant.recoveredAt)) {
    input.logger.error(
      { requestId: plan.requestId },
      'Controlled restart participant recovery remains incomplete; retaining durable handoff for startup replay',
    );
    return next;
  }

  const completedAt = input.now ?? Date.now();
  next = {
    ...next,
    status: 'completed',
    participants: next.participants.map((participant) => {
      const redacted = { ...participant, userPrompt: '' };
      delete redacted.cardState;
      delete redacted.queuedPrompts;
      return redacted;
    }),
    completedAt,
    updatedAt: completedAt,
  };
  writeControlledRestartPlan(next);
  if (breadcrumb) clearRestartBreadcrumb(next.requestId);
  return next;
}

export function readControlledRestartPlan(): ControlledRestartPlan | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(controlledRestartPlanPath(), 'utf8')) as ControlledRestartPlan;
    if (!isControlledRestartPlan(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function controlledRestartPlanPath(): string {
  const dir = process.env.SESSION_STORE_DIR || path.join(os.homedir(), '.metabot');
  return path.join(dir, PLAN_FILENAME);
}

function collectParticipants(
  registered: RegisteredBot[],
  request: ControlledRestartRequest,
): ControlledRestartParticipant[] {
  const participants = new Map<string, ControlledRestartParticipant>();
  for (const bot of registered) {
    for (const task of bot.bridge.getRestartTaskSnapshots()) {
      const participant: ControlledRestartParticipant = {
        ...task,
        botName: bot.name,
        platform: bot.platform,
        wasActive: true,
      };
      participants.set(participantKey(participant), participant);
    }
  }

  if (request.requesterBot && request.requesterChat) {
    const bot = registered.find((candidate) => candidate.name === request.requesterBot);
    if (bot) {
      const key = `${bot.platform}\0${bot.name}\0${request.requesterChat}`;
      if (!participants.has(key)) {
        participants.set(key, {
          botName: bot.name,
          platform: bot.platform,
          chatId: request.requesterChat,
          userPrompt: request.reason || 'MetaBot restart requested from this chat.',
          startedAt: Date.now(),
          source: 'api',
          sendCards: true,
          wasActive: false,
        });
      }
    }
  }
  return [...participants.values()].sort((a, b) => a.startedAt - b.startedAt);
}

function refreshParticipants(
  registered: RegisteredBot[],
  participants: ControlledRestartParticipant[],
): ControlledRestartParticipant[] {
  const active = new Map<string, RestartTaskSnapshot>();
  for (const bot of registered) {
    for (const task of bot.bridge.getRestartTaskSnapshots()) {
      active.set(`${bot.platform}\0${bot.name}\0${task.chatId}`, task);
    }
  }
  return participants.map((participant) => {
    const current = active.get(participantKey(participant));
    if (!current) return { ...participant, wasActive: false };
    return {
      ...participant,
      ...current,
      botName: participant.botName,
      platform: participant.platform,
      wasActive: true,
    };
  });
}

function resolveParticipantBot(registry: BotRegistry, participant: ControlledRestartParticipant): RegisteredBot | undefined {
  return registry.getByPlatform(participant.botName, participant.platform) ?? registry.get(participant.botName);
}

function releaseQuiesce(registered: RegisteredBot[], requestId: string): void {
  for (const bot of registered) bot.bridge.cancelRestartQuiesce(requestId);
}

function armPreparationLease(registry: BotRegistry, logger: Logger, requestId: string): void {
  clearPreparationLease(requestId);
  const timer = setTimeout(() => {
    const plan = readControlledRestartPlan();
    if (!plan || plan.requestId !== requestId || (plan.status !== 'preparing' && plan.status !== 'prepared')) return;
    cancelControlledRestart({ registry, requestId });
    clearRestartBreadcrumb(requestId);
    logger.warn({ requestId }, 'Controlled restart preparation expired; Bridge quiesce was released');
  }, PREPARE_LEASE_MS);
  timer.unref?.();
  preparationLeases.set(requestId, timer);
}

function clearPreparationLease(requestId: string): void {
  const timer = preparationLeases.get(requestId);
  if (timer) clearTimeout(timer);
  preparationLeases.delete(requestId);
}

function buildPreparingNotice(plan: ControlledRestartPlan, participant: ControlledRestartParticipant): string {
  return [
    `Controlled restart ${plan.requestId} is about to restart the shared MetaBot Bridge.`,
    plan.reason ? `Reason: ${plan.reason}` : '',
    participant.wasActive
      ? plan.resume
        ? 'This bot has active work. Its task state has been checkpointed and a continuation will be queued after the Bridge is healthy.'
        : 'This bot has active work. Its task state has been checkpointed, but automatic continuation was disabled for this restart.'
      : 'This chat requested the restart and will receive the completion result after the Bridge is healthy.',
    'New work is briefly paused until the restart finishes.',
  ].filter(Boolean).join('\n');
}

function buildCompletionNotice(
  plan: ControlledRestartPlan,
  participant: ControlledRestartParticipant,
  outcome: ControlledRestartParticipant['continuationOutcome'],
): string {
  return [
    `Controlled restart ${plan.requestId} completed and the Bridge is online.`,
    outcome === 'scheduled'
      ? 'A continuation turn was queued for the interrupted work.'
      : outcome === 'failed'
        ? 'The interrupted work could not be queued automatically; inspect the Bridge logs before retrying.'
        : participant.wasActive && !plan.resume
          ? 'Automatic continuation was disabled for this restart.'
        : participant.wasActive
          ? 'This task is owned by an internal runtime and was not replayed as a user chat.'
          : 'No in-flight turn was recorded in this chat, so no continuation was needed.',
  ].join('\n');
}

function buildRecoveredCard(
  participant: ControlledRestartParticipant,
  continuationQueued: boolean,
  now: number,
): CardState {
  const previous = participant.cardState;
  const restartText = continuationQueued
    ? 'MetaBot restarted successfully. A continuation turn was queued for the interrupted work.'
    : 'MetaBot restarted, but no continuation turn was queued for this task.';
  return {
    ...previous,
    status: continuationQueued ? 'complete' : 'error',
    userPrompt: previous?.userPrompt || participant.userPrompt,
    responseText: [previous?.responseText, restartText].filter(Boolean).join('\n\n'),
    toolCalls: previous?.toolCalls || [],
    durationMs: Math.max(previous?.durationMs || 0, now - participant.startedAt),
    pendingQuestion: undefined,
    errorMessage: continuationQueued ? undefined : 'Task interrupted by service restart',
  };
}

function buildContinuationPrompt(plan: ControlledRestartPlan, participant: ControlledRestartParticipant): string {
  const previous = participant.userPrompt.length > 2000
    ? `${participant.userPrompt.slice(0, 1997)}...`
    : participant.userPrompt;
  return [
    '<system-reminder>',
    `Controlled MetaBot restart ${plan.requestId} completed successfully.`,
    'The Bridge process and this engine turn were interrupted by that restart.',
    'Continue the interrupted task from the existing chat/session context.',
    'Verify the post-restart state, finish only the remaining work, and do not restart or update again merely to satisfy the interrupted request.',
    '',
    'Interrupted user prompt:',
    previous,
    ...(participant.queuedPrompts?.length
      ? [
        '',
        'Messages that were queued behind the interrupted turn, in order:',
        ...participant.queuedPrompts.map((prompt, index) => `${index + 1}. ${prompt.slice(0, 1000)}`),
      ]
      : []),
    '</system-reminder>',
  ].join('\n');
}

function continuationKey(requestId: string, participant: ControlledRestartParticipant): string {
  return `restart-resume:${requestId}:${participant.platform}:${participant.botName}:${participant.chatId}`;
}

function participantKey(participant: Pick<ControlledRestartParticipant, 'platform' | 'botName' | 'chatId'>): string {
  return `${participant.platform}\0${participant.botName}\0${participant.chatId}`;
}

function isInternalExecutionChat(chatId: string): boolean {
  return chatId.startsWith('team:')
    || chatId.startsWith('teaminst:')
    || chatId.startsWith('worker:')
    || chatId.startsWith('worker-')
    || chatId.startsWith('arc:')
    || chatId.startsWith('arc-');
}

function writeControlledRestartPlan(plan: ControlledRestartPlan): void {
  const file = controlledRestartPlanPath();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(plan, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}

function assertRequestId(requestId: string): void {
  if (!REQUEST_ID_RE.test(requestId)) {
    throw new RestartPreparationError('Invalid controlled restart request ID', 400);
  }
}

function isControlledRestartPlan(value: unknown): value is ControlledRestartPlan {
  const plan = value as ControlledRestartPlan;
  return !!plan
    && plan.version === 1
    && typeof plan.requestId === 'string'
    && REQUEST_ID_RE.test(plan.requestId)
    && ['preparing', 'prepared', 'cancelled', 'completed'].includes(plan.status)
    && typeof plan.resume === 'boolean'
    && typeof plan.force === 'boolean'
    && Array.isArray(plan.participants)
    && typeof plan.createdAt === 'number'
    && typeof plan.updatedAt === 'number';
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
