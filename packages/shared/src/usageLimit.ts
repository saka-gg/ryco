/**
 * Usage-limit policy shared by the server worker, web and mobile. Every function is
 * pure, so all surfaces agree on when a thread is Limited, when its queue is held and
 * when the server may resume it.
 *
 * @module usageLimit
 */
import {
  CommandId,
  MessageId,
  type ThreadId,
  type ThreadUsageLimit,
  type TurnId,
} from "@ryco/contracts";

/** The text a usage-limit resume sends, from the banner or the server worker. */
export const USAGE_LIMIT_RESUME_MESSAGE = "Continue where you left off.";
/** Resume this long after the reported reset, to absorb clock skew. */
export const USAGE_LIMIT_RESUME_GRACE_MS = 30_000;
/** The client queue hold ends this long after the reset, after an armed worker resumed. */
export const USAGE_LIMIT_HOLD_RELEASE_MS = 2 * 60_000;
/** A worker that comes back later than this after the reset leaves the thread alone. */
export const USAGE_LIMIT_AUTO_RESUME_MAX_LATENESS_MS = 24 * 3_600_000;

export function usageLimitIdForTurn(threadId: ThreadId | string, turnId: TurnId | string): string {
  return `usage-limit:${threadId}:${turnId}`;
}

/** Ingestion's record command; duplicates of the same limit dedupe on the engine receipt. */
export function usageLimitRecordCommandId(limitId: string): CommandId {
  return CommandId.make(`usage-limit-record:${limitId}`);
}

/** Fills an unknown `resetAt` once per limit. */
export function usageLimitResetFillCommandId(limitId: string): CommandId {
  return CommandId.make(`usage-limit-reset:${limitId}`);
}

/** Deterministic, so a replayed snooze never undoes a user's later unsnooze. */
export function usageLimitSnoozeCommandId(limitId: string, resetAt: string): CommandId {
  return CommandId.make(`usage-limit-snooze:${limitId}:${Date.parse(resetAt)}`);
}

/** One identity for the banner's Resume now and the worker's auto-resume. */
export function usageLimitResumeIds(limitId: string): {
  readonly commandId: CommandId;
  readonly messageId: MessageId;
} {
  const id = `usage-limit-resume:${limitId}`;
  return { commandId: CommandId.make(id), messageId: MessageId.make(id) };
}

export interface UsageLimitThreadInput {
  readonly usageLimit?: ThreadUsageLimit | null | undefined;
  readonly modelSelection?: { readonly instanceId: string } | null | undefined;
}

/** The limit only gates the thread while it still targets the limited instance. */
export function applicableUsageLimit(thread: UsageLimitThreadInput): ThreadUsageLimit | null {
  const limit = thread.usageLimit ?? null;
  if (limit === null) return null;
  if (thread.modelSelection?.instanceId !== limit.providerInstanceId) return null;
  return limit;
}

/** null follows the node setting; an explicit per-thread override wins. */
export function effectiveUsageLimitAutoResume(
  limit: Pick<ThreadUsageLimit, "autoResume">,
  nodeSetting: boolean,
): boolean {
  return limit.autoResume ?? nodeSetting;
}

function parseIso(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export type UsageLimitPhase = "limited" | "reset";

/** "limited" until the reported reset; an unknown reset stays limited. */
export function usageLimitPhase(
  limit: Pick<ThreadUsageLimit, "resetAt">,
  nowMs: number,
): UsageLimitPhase {
  const resetMs = parseIso(limit.resetAt);
  return resetMs === null || nowMs < resetMs ? "limited" : "reset";
}

/** A reset at or before the limit itself cannot start a retry (an already-expired window). */
export function isUsageLimitResetFresh(
  limit: Pick<ThreadUsageLimit, "resetAt" | "limitedAt">,
): boolean {
  const resetMs = parseIso(limit.resetAt);
  const limitedMs = parseIso(limit.limitedAt);
  return resetMs !== null && limitedMs !== null && resetMs > limitedMs;
}

/**
 * Queued follow-ups wait while the thread is limited: until two minutes after a known
 * reset (long enough for an armed worker to resume first), indefinitely when unknown.
 */
export function isUsageLimitQueueHeld(thread: UsageLimitThreadInput, nowMs: number): boolean {
  const limit = applicableUsageLimit(thread);
  if (limit === null) return false;
  const resetMs = parseIso(limit.resetAt);
  return resetMs === null || nowMs < resetMs + USAGE_LIMIT_HOLD_RELEASE_MS;
}

/** When the hold ends; null when the thread is not held or its reset is unknown. */
export function usageLimitHoldReleaseAtMs(
  thread: UsageLimitThreadInput,
  nowMs: number,
): number | null {
  if (!isUsageLimitQueueHeld(thread, nowMs)) return null;
  const resetMs = parseIso(applicableUsageLimit(thread)?.resetAt);
  return resetMs === null ? null : resetMs + USAGE_LIMIT_HOLD_RELEASE_MS;
}

export interface UsageLimitAutoResumeThread extends UsageLimitThreadInput {
  readonly archivedAt?: string | null | undefined;
  readonly deletedAt?: string | null | undefined;
  readonly settledOverride?: string | null | undefined;
  readonly snoozedUntil?: string | null | undefined;
  readonly hasPendingApprovals?: boolean | undefined;
  readonly hasPendingUserInput?: boolean | undefined;
  readonly session?: { readonly status: string } | null | undefined;
  readonly latestTurn?: { readonly state: string } | null | undefined;
}

export type UsageLimitAutoResumeBlocker =
  | "not-limited"
  | "instance-mismatch"
  | "not-armed"
  | "reset-unknown"
  | "reset-stale"
  | "before-reset"
  | "too-late"
  | "archived"
  | "settled"
  | "snoozed"
  | "pending-request"
  | "busy";

/** Server worker eligibility for an automatic resume; null = resume now. */
export function usageLimitAutoResumeBlocker(input: {
  readonly thread: UsageLimitAutoResumeThread;
  readonly nodeSetting: boolean;
  readonly nowMs: number;
}): UsageLimitAutoResumeBlocker | null {
  const { thread, nowMs } = input;
  const limit = thread.usageLimit ?? null;
  if (limit === null) return "not-limited";
  if (applicableUsageLimit(thread) === null) return "instance-mismatch";
  if (!effectiveUsageLimitAutoResume(limit, input.nodeSetting)) return "not-armed";
  const resetMs = parseIso(limit.resetAt);
  if (resetMs === null) return "reset-unknown";
  if (!isUsageLimitResetFresh(limit)) return "reset-stale";
  if (nowMs < resetMs + USAGE_LIMIT_RESUME_GRACE_MS) return "before-reset";
  if (nowMs - resetMs > USAGE_LIMIT_AUTO_RESUME_MAX_LATENESS_MS) return "too-late";
  if ((thread.archivedAt ?? null) !== null || (thread.deletedAt ?? null) !== null) {
    return "archived";
  }
  if (thread.settledOverride === "settled") return "settled";
  const snoozedUntilMs = parseIso(thread.snoozedUntil);
  if (snoozedUntilMs !== null && snoozedUntilMs > nowMs) return "snoozed";
  if (thread.hasPendingApprovals === true || thread.hasPendingUserInput === true) {
    return "pending-request";
  }
  const status = thread.session?.status;
  if (status === "running" || status === "starting" || thread.latestTurn?.state === "running") {
    return "busy";
  }
  return null;
}
