import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Restart breadcrumb + one-shot reminder.
 *
 * `pm2 restart` kills the whole Bridge process — including every active engine
 * turn — and respawns it. The agent that ran `metabot restart` therefore loses all
 * memory of having done so; when the next message arrives the session resumes
 * with "please restart" still in its history and the agent restarts again, in a
 * loop. To break it, `bin/metabot` writes a timestamp breadcrumb just before
 * `pm2 restart`; we retain it at boot until coordinated recovery has queued
 * every continuation. The legacy one-shot reminder remains as a compatibility
 * fallback for breadcrumbs created by an older CLI.
 */

const BREADCRUMB_FILENAME = 'last-restart.json';
// Only treat the breadcrumb as a "fresh restart" within this window. Guards
// against a stale file (e.g. a crash where boot never ran to delete it) firing
// the reminder days later on an unrelated start.
const RESTART_WINDOW_MS = 15 * 60 * 1000;

let restartedAtMs: number | undefined;
const remindedChats = new Set<string>();

function breadcrumbPath(): string {
  const dir = process.env.SESSION_STORE_DIR || path.join(os.homedir(), '.metabot');
  return path.join(dir, BREADCRUMB_FILENAME);
}

/**
 * Read the restart breadcrumb at boot and retain it until restart recovery has
 * reached a durable decision. Call once during bridge startup. Safe to call
 * when no breadcrumb exists.
 */
export interface RestartBreadcrumb {
  version?: number;
  restartedAt: number;
  requestId?: string;
  botName?: string;
  chatId?: string;
  source?: string;
  reason?: string;
  resume?: boolean;
}

let restartBreadcrumb: RestartBreadcrumb | undefined;

export function loadRestartBreadcrumb(): RestartBreadcrumb | undefined {
  const file = breadcrumbPath();
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<RestartBreadcrumb>;
    if (typeof parsed.restartedAt === 'number') {
      restartedAtMs = parsed.restartedAt * 1000; // breadcrumb stores epoch seconds
      restartBreadcrumb = {
        ...parsed,
        restartedAt: parsed.restartedAt,
      };
    }
  } catch {
    /* missing/unreadable — nothing to do */
  }
  return restartBreadcrumb;
}

export function getRestartBreadcrumb(): RestartBreadcrumb | undefined {
  return restartBreadcrumb;
}

/** Delete a consumed breadcrumb after recovery/reporting is durably decided. */
export function clearRestartBreadcrumb(requestId?: string): void {
  if (requestId && restartBreadcrumb?.requestId && restartBreadcrumb.requestId !== requestId) return;
  try {
    fs.unlinkSync(breadcrumbPath());
  } catch {
    /* already gone */
  }
  restartBreadcrumb = undefined;
}

/** True if we should inject the restart reminder for this chat's next turn. */
export function shouldRemindRestart(chatId: string): boolean {
  if (restartedAtMs === undefined) return false;
  if (Date.now() - restartedAtMs > RESTART_WINDOW_MS) return false;
  return !remindedChats.has(chatId);
}

/** Mark a chat as having received the restart reminder (one-shot per chat). */
export function markReminded(chatId: string): void {
  remindedChats.add(chatId);
}

/** Whole seconds since the recorded restart (0 if unknown). */
export function restartSecondsAgo(): number {
  if (restartedAtMs === undefined) return 0;
  return Math.max(0, Math.round((Date.now() - restartedAtMs) / 1000));
}
