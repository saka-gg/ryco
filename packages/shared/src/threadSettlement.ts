import { DEFAULT_SIDEBAR_AUTO_SETTLE_AFTER_DAYS } from "@ryco/contracts/settings";
import type {
  OrchestrationLatestTurnState,
  OrchestrationSessionStatus,
  PullRequestState,
  SidebarAutoSettleAfterDays,
  ThreadSettlementOverride,
} from "@ryco/contracts";

/** Missing preferences use the shared default; null is an explicit opt-out. */
export function resolveAutoSettleAfterDays(
  value: SidebarAutoSettleAfterDays | undefined,
): SidebarAutoSettleAfterDays {
  return value === undefined ? DEFAULT_SIDEBAR_AUTO_SETTLE_AFTER_DAYS : value;
}

export const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;
export const THREAD_AUTO_SETTLE_DAY_MS = 24 * 60 * 60 * 1_000;

export type ThreadSettlementBlocker =
  | "unsupported"
  | "thread-archived"
  | "thread-deleted"
  | "worktree-archived"
  | "pending-approval"
  | "pending-user-input"
  | "session-starting"
  | "session-running"
  | "queued-turn"
  | "local-queue"
  | "delivery-unknown";

export interface ThreadSettlementInput {
  readonly threadSettlementSupported: boolean;
  readonly archivedAt: string | null;
  readonly deletedAt: string | null;
  readonly worktreeArchivedAt: string | null;
  readonly settledOverride: ThreadSettlementOverride | null;
  readonly settledAt: string | null;
  readonly sessionStatus: OrchestrationSessionStatus | null;
  readonly latestTurnState: OrchestrationLatestTurnState | null;
  readonly latestTurnRequestedAt: string | null;
  readonly latestTurnStartedAt: string | null;
  readonly latestTurnCompletedAt: string | null;
  readonly latestUserMessageAt: string | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly hasLocalQueuedMessage: boolean;
  readonly deliveryUnknown: boolean;
  readonly prState: PullRequestState | null;
  readonly worktreeUpdatedAt: string | null;
  readonly updatedAt: string | null;
  readonly createdAt: string;
  readonly autoSettleAfterDays: SidebarAutoSettleAfterDays;
  readonly nowMs: number;
}

export interface CanSettleThreadResult {
  readonly canSettle: boolean;
  readonly blocker: ThreadSettlementBlocker | null;
}

export type ThreadSettlementClassification = "active" | "settled" | "excluded";

function timestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function hasQueuedTurnStart(input: ThreadSettlementInput): boolean {
  if (input.latestTurnState === "error" || input.sessionStatus === "error") {
    return false;
  }

  const latestUserMessageAt = timestampMs(input.latestUserMessageAt);
  if (latestUserMessageAt === null) {
    return input.latestUserMessageAt !== null;
  }

  if (input.latestTurnRequestedAt !== null) {
    const latestTurnRequestedAt = timestampMs(input.latestTurnRequestedAt);
    if (latestTurnRequestedAt === null) return true;
    if (latestTurnRequestedAt >= latestUserMessageAt) return false;
  }

  if (!Number.isFinite(input.nowMs)) return true;
  const ageMs = input.nowMs - latestUserMessageAt;
  return ageMs < 0 || ageMs <= QUEUED_TURN_START_GRACE_MS;
}

function blocked(blocker: ThreadSettlementBlocker): CanSettleThreadResult {
  return { canSettle: false, blocker };
}

export function canSettleThread(input: ThreadSettlementInput): CanSettleThreadResult {
  if (!input.threadSettlementSupported) return blocked("unsupported");
  if (input.archivedAt !== null) return blocked("thread-archived");
  if (input.deletedAt !== null) return blocked("thread-deleted");
  if (input.worktreeArchivedAt !== null) return blocked("worktree-archived");
  if (input.hasPendingApprovals) return blocked("pending-approval");
  if (input.hasPendingUserInput) return blocked("pending-user-input");
  if (input.sessionStatus === "starting") return blocked("session-starting");
  if (input.sessionStatus === "running" || input.latestTurnState === "running")
    return blocked("session-running");
  if (input.hasLocalQueuedMessage) return blocked("local-queue");
  if (input.deliveryUnknown) return blocked("delivery-unknown");
  if (hasQueuedTurnStart(input)) return blocked("queued-turn");
  return { canSettle: true, blocker: null };
}

function newestValidTimestamp(candidates: ReadonlyArray<string | null>): string | null {
  let newest: { value: string; ms: number } | null = null;
  for (const candidate of candidates) {
    const ms = timestampMs(candidate);
    if (candidate === null || ms === null) continue;
    if (newest === null || ms > newest.ms) {
      newest = { value: candidate, ms };
    }
  }
  return newest?.value ?? null;
}

export function getThreadLastActivityTimestamp(input: ThreadSettlementInput): string | null {
  return newestValidTimestamp([
    input.latestUserMessageAt,
    input.latestTurnRequestedAt,
    input.latestTurnStartedAt,
    input.latestTurnCompletedAt,
  ]);
}

function autoSettleBoundaryMs(input: ThreadSettlementInput): number | null {
  if (
    input.autoSettleAfterDays === null ||
    !Number.isInteger(input.autoSettleAfterDays) ||
    input.autoSettleAfterDays < 1 ||
    input.autoSettleAfterDays > 90
  ) {
    return null;
  }
  const lastActivityAt = timestampMs(getThreadLastActivityTimestamp(input));
  if (lastActivityAt === null) return null;
  const boundaryMs = lastActivityAt + input.autoSettleAfterDays * THREAD_AUTO_SETTLE_DAY_MS;
  return Number.isFinite(boundaryMs) ? boundaryMs : null;
}

function canUseInactivitySettlement(input: ThreadSettlementInput): boolean {
  return input.settledOverride === null && input.prState === null;
}

export function getNextThreadSettlementEvaluationAtMs(input: ThreadSettlementInput): number | null {
  if (!canUseInactivitySettlement(input) || !Number.isFinite(input.nowMs)) return null;
  const autoSettleAtMs = autoSettleBoundaryMs(input);
  if (autoSettleAtMs === null) return null;

  const eligibility = canSettleThread(input);
  if (!eligibility.canSettle && eligibility.blocker !== "queued-turn") return null;

  const candidates: number[] = [];
  if (autoSettleAtMs > input.nowMs) candidates.push(autoSettleAtMs);
  if (eligibility.blocker === "queued-turn") {
    const latestUserMessageAtMs = timestampMs(input.latestUserMessageAt);
    if (latestUserMessageAtMs !== null) {
      const queuedTurnGraceEndsAtMs = latestUserMessageAtMs + QUEUED_TURN_START_GRACE_MS + 1;
      if (queuedTurnGraceEndsAtMs > input.nowMs) candidates.push(queuedTurnGraceEndsAtMs);
    }
  }
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

export function getEffectiveSettlementTimestamp(input: ThreadSettlementInput): string | null {
  if (input.settledOverride === "settled") {
    return timestampMs(input.settledAt) === null ? null : input.settledAt;
  }
  if (input.prState === "merged" || input.prState === "closed") {
    return newestValidTimestamp([
      input.worktreeUpdatedAt,
      input.latestTurnCompletedAt,
      input.latestUserMessageAt,
      input.updatedAt,
      input.createdAt,
    ]);
  }
  if (!canUseInactivitySettlement(input) || !canSettleThread(input).canSettle) return null;
  const boundaryMs = autoSettleBoundaryMs(input);
  if (boundaryMs === null || !Number.isFinite(input.nowMs) || input.nowMs < boundaryMs) return null;
  return new Date(boundaryMs).toISOString();
}

export function classifyThreadSettlement(
  input: ThreadSettlementInput,
): ThreadSettlementClassification {
  if (input.archivedAt !== null || input.deletedAt !== null || input.worktreeArchivedAt !== null) {
    return "excluded";
  }
  if (!canSettleThread(input).canSettle) return "active";
  if (input.settledOverride === "settled") {
    return getEffectiveSettlementTimestamp(input) === null ? "active" : "settled";
  }
  if (input.settledOverride === "active") return "active";
  if (
    (input.prState === "merged" || input.prState === "closed") &&
    getEffectiveSettlementTimestamp(input) !== null
  ) {
    return "settled";
  }
  if (getEffectiveSettlementTimestamp(input) !== null) return "settled";
  return "active";
}

export interface ActiveInboxSortInput {
  readonly scopedKey: string;
  readonly pinned: boolean;
  readonly createdAt: string;
}

export function compareActiveInboxEntries(
  left: ActiveInboxSortInput,
  right: ActiveInboxSortInput,
): number {
  if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
  const leftCreatedAt = timestampMs(left.createdAt) ?? Number.NEGATIVE_INFINITY;
  const rightCreatedAt = timestampMs(right.createdAt) ?? Number.NEGATIVE_INFINITY;
  if (leftCreatedAt !== rightCreatedAt) return rightCreatedAt - leftCreatedAt;
  return left.scopedKey.localeCompare(right.scopedKey);
}

export interface SettledInboxSortInput {
  readonly scopedKey: string;
  readonly effectiveSettlementTimestamp: string | null;
  readonly createdAt: string;
}

export function compareSettledInboxEntries(
  left: SettledInboxSortInput,
  right: SettledInboxSortInput,
): number {
  const leftSettledAt = timestampMs(left.effectiveSettlementTimestamp) ?? Number.NEGATIVE_INFINITY;
  const rightSettledAt =
    timestampMs(right.effectiveSettlementTimestamp) ?? Number.NEGATIVE_INFINITY;
  if (leftSettledAt !== rightSettledAt) return rightSettledAt - leftSettledAt;
  const leftCreatedAt = timestampMs(left.createdAt) ?? Number.NEGATIVE_INFINITY;
  const rightCreatedAt = timestampMs(right.createdAt) ?? Number.NEGATIVE_INFINITY;
  if (leftCreatedAt !== rightCreatedAt) return rightCreatedAt - leftCreatedAt;
  return left.scopedKey.localeCompare(right.scopedKey);
}
