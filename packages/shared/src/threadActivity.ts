import {
  CHECKPOINT_REVERT_ACTIVITY_KIND,
  CONTEXT_HANDOFF_ACTIVITY_KIND,
  ContextHandoffActivityPayload,
  type OrchestrationThreadActivity,
} from "@ryco/contracts/orchestration";
import { THREAD_FORKED_ACTIVITY_KIND } from "@ryco/contracts/thread-fork";
import * as Schema from "effect/Schema";
import { backgroundWorkCheckpoint, BACKGROUND_WORK_CHECKPOINT } from "./backgroundWork.ts";
import { isForkBaseItemId } from "./threadFork.ts";

export const CONTEXT_COMPACTION_ACTIVITY_KIND = "context-compaction";

const decodeContextHandoffActivityPayload = Schema.decodeUnknownSync(ContextHandoffActivityPayload);

export function isContextCompactionActivity(
  activity: Pick<OrchestrationThreadActivity, "kind">,
): boolean {
  return activity.kind === CONTEXT_COMPACTION_ACTIVITY_KIND;
}

export function isTerminalContextHandoffActivity(
  activity: Pick<OrchestrationThreadActivity, "kind" | "payload">,
): boolean {
  if (activity.kind !== CONTEXT_HANDOFF_ACTIVITY_KIND) {
    return false;
  }

  try {
    const payload = decodeContextHandoffActivityPayload(activity.payload);
    return (
      payload.status === "consumed" ||
      payload.status === "failed" ||
      payload.status === "delivery-uncertain"
    );
  } catch {
    return false;
  }
}

/**
 * A forked thread's single provenance activity (see `@ryco/shared/threadFork`). It is a
 * milestone by kind alone: it anchors the fork-origin timeline entry, and the decider reads it
 * to decide whether the fork still owes a provider its inherited conversation.
 */
export function isThreadForkedActivity(
  activity: Pick<OrchestrationThreadActivity, "kind">,
): boolean {
  return activity.kind === THREAD_FORKED_ACTIVITY_KIND;
}

export function isThreadActivityMilestone(
  activity: Pick<OrchestrationThreadActivity, "kind" | "payload">,
): boolean {
  return (
    isContextCompactionActivity(activity) ||
    isTerminalContextHandoffActivity(activity) ||
    isThreadForkedActivity(activity)
  );
}

/**
 * Input must already be sorted in display order. Keeps the recent activity cap
 * predictable while preserving long-lived timeline milestones.
 */
export function capThreadActivitiesPreservingMilestones<
  T extends Pick<OrchestrationThreadActivity, "id" | "kind" | "payload">,
>(activities: ReadonlyArray<T>, limit: number): T[] {
  if (activities.length <= limit) {
    return [...activities];
  }

  const recent = activities.slice(-limit);
  // A newer snapshot checkpoint already covers the older page being merged.
  const checkpoint = recent.some((activity) => activity.kind === BACKGROUND_WORK_CHECKPOINT)
    ? undefined
    : backgroundWorkCheckpoint(activities.slice(0, -limit));
  const recentIds = new Set(recent.map((activity) => activity.id));
  const preserved = activities.filter(
    (activity) => isThreadActivityMilestone(activity) && !recentIds.has(activity.id),
  );

  return [...preserved, ...(checkpoint ? [checkpoint] : []), ...recent];
}

/**
 * The activity kinds `derivePendingThreadRequests` reads: they open, resolve or clear a pending
 * approval or user-input request.
 */
export const PENDING_REQUEST_ACTIVITY_KINDS = [
  "approval.requested",
  "approval.resolved",
  "provider.approval.respond.failed",
  "user-input.requested",
  "user-input.resolved",
  "provider.user-input.respond.failed",
] as const;

interface PendingThreadRequestActivity {
  readonly kind: string;
  readonly payload: unknown;
  readonly createdAt: string;
  readonly id?: string | undefined;
  readonly activityId?: string | undefined;
  readonly sequence?: number | undefined;
  readonly turnId?: string | null | undefined;
}

export interface PendingThreadRequestState {
  readonly pendingApprovalCount: number;
  readonly pendingUserInputCount: number;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
}

function activityRequestId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || !("requestId" in payload)) {
    return null;
  }
  const requestId = (payload as { requestId?: unknown }).requestId;
  return typeof requestId === "string" && requestId.length > 0 ? requestId : null;
}

function activityFailureDetail(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || !("detail" in payload)) {
    return null;
  }
  const detail = (payload as { detail?: unknown }).detail;
  return typeof detail === "string" ? detail.toLowerCase() : null;
}

function isStaleRequestFailure(detail: string | null, requestKind: "approval" | "user-input") {
  if (detail === null) return false;
  if (requestKind === "approval") {
    return (
      detail.includes("stale pending approval request") ||
      detail.includes("unknown pending approval request") ||
      detail.includes("unknown pending permission request")
    );
  }
  return (
    detail.includes("stale pending user-input request") ||
    detail.includes("unknown pending user-input request")
  );
}

function comparePendingRequestActivities(
  left: PendingThreadRequestActivity,
  right: PendingThreadRequestActivity,
): number {
  const bySequence =
    (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER);
  if (bySequence !== 0) return bySequence;
  const byCreatedAt = left.createdAt.localeCompare(right.createdAt);
  if (byCreatedAt !== 0) return byCreatedAt;
  return (left.id ?? left.activityId ?? "").localeCompare(right.id ?? right.activityId ?? "");
}

export function derivePendingThreadRequests(
  activities: ReadonlyArray<PendingThreadRequestActivity>,
): ReadonlyArray<{
  readonly requestId: string;
  readonly kind: "approval" | "user-input";
  readonly nonBlocking?: boolean;
  readonly turnId: string | null;
}> {
  const approvalIds = new Map<string, string | null>();
  const userInputIds = new Map<string, string | null>();
  const optionalIds = new Set<string>();

  for (const activity of activities.toSorted(comparePendingRequestActivities)) {
    const requestId = activityRequestId(activity.payload);
    if (requestId === null) continue;

    if (activity.kind === "approval.requested") {
      approvalIds.set(requestId, activity.turnId ?? null);
    } else if (activity.kind === "approval.resolved") {
      approvalIds.delete(requestId);
    } else if (
      activity.kind === "provider.approval.respond.failed" &&
      isStaleRequestFailure(activityFailureDetail(activity.payload), "approval")
    ) {
      approvalIds.delete(requestId);
    } else if (activity.kind === "user-input.requested") {
      userInputIds.set(requestId, activity.turnId ?? null);
      if ((activity.payload as { nonBlocking?: unknown })?.nonBlocking === true)
        optionalIds.add(requestId);
      else optionalIds.delete(requestId);
    } else if (activity.kind === "user-input.resolved") {
      userInputIds.delete(requestId);
    } else if (
      activity.kind === "provider.user-input.respond.failed" &&
      isStaleRequestFailure(activityFailureDetail(activity.payload), "user-input")
    ) {
      userInputIds.delete(requestId);
    }
  }

  return [
    ...Array.from(approvalIds, ([requestId, turnId]) => ({
      requestId,
      turnId,
      kind: "approval" as const,
    })),
    ...Array.from(userInputIds, ([requestId, turnId]) => ({
      requestId,
      turnId,
      kind: "user-input" as const,
      ...(optionalIds.has(requestId) ? { nonBlocking: true } : {}),
    })),
  ];
}

export function derivePendingThreadRequestState(
  activities: ReadonlyArray<PendingThreadRequestActivity>,
): PendingThreadRequestState {
  const requests = derivePendingThreadRequests(activities);
  const pendingApprovalCount = requests.filter((request) => request.kind === "approval").length;
  const pendingUserInputCount = requests.filter(
    (request) => request.kind === "user-input" && !request.nonBlocking,
  ).length;
  return {
    pendingApprovalCount,
    pendingUserInputCount,
    hasPendingApprovals: pendingApprovalCount > 0,
    hasPendingUserInput: pendingUserInputCount > 0,
  };
}

/** Response attempts and provider callbacks share the durable orchestration order.
 * Provider-local sequence numbers cannot be compared to local response attempts.
 */
export function pendingRequestActivityInOrchestrationOrder(
  activity: OrchestrationThreadActivity,
  sequence: number,
): OrchestrationThreadActivity {
  return activity.kind.startsWith("approval.") ||
    activity.kind === "provider.approval.respond.failed" ||
    activity.kind.startsWith("user-input.") ||
    activity.kind === "provider.user-input.respond.failed"
    ? { ...activity, sequence }
    : activity;
}

interface ThreadActivityOrderKey {
  readonly id: string;
  readonly createdAt: string;
  readonly sequence?: number | undefined;
}

/**
 * Orders by the durable orchestration sequence alone: activities with a sequence sort after
 * those without, and equal or both-missing sequences compare as 0 so the caller's tiebreakers
 * apply.
 */
export function compareThreadActivitySequence(
  left: Pick<ThreadActivityOrderKey, "sequence">,
  right: Pick<ThreadActivityOrderKey, "sequence">,
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    return left.sequence - right.sequence;
  }
  if (left.sequence !== undefined) return 1;
  if (right.sequence !== undefined) return -1;
  return 0;
}

/** The display order of a thread's activities: sequence, then creation time, then id. */
export function compareThreadActivities(
  left: ThreadActivityOrderKey,
  right: ThreadActivityOrderKey,
): number {
  return (
    compareThreadActivitySequence(left, right) ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

function isFailedCheckpointRevert(activity: Pick<OrchestrationThreadActivity, "payload">): boolean {
  const { payload } = activity;
  return (
    payload !== null &&
    typeof payload === "object" &&
    "status" in payload &&
    payload.status === "failed"
  );
}

/**
 * A thread's newest `checkpoint.revert` journal row in display order, or null. With
 * `skipFailed`, rows of reverts that failed are passed over: a failed revert changed nothing,
 * so the row before it still says what the thread's reverts left in its checkout. The server's
 * shared-checkout check and every client's restore warning pick their row here.
 */
export function latestCheckpointRevertActivity<
  T extends ThreadActivityOrderKey & Pick<OrchestrationThreadActivity, "kind" | "payload">,
>(activities: ReadonlyArray<T>, options?: { readonly skipFailed?: boolean }): T | null {
  let latest: T | null = null;
  for (const activity of activities) {
    if (activity.kind !== CHECKPOINT_REVERT_ACTIVITY_KIND) continue;
    if (options?.skipFailed === true && isFailedCheckpointRevert(activity)) continue;
    if (latest === null || compareThreadActivities(activity, latest) > 0) latest = activity;
  }
  return latest;
}

/** A start before its progress, progress before its completion or resolution. */
function threadActivityLifecycleRank(kind: string): number {
  if (kind.endsWith(".started")) return 0;
  if (kind.endsWith(".completed") || kind.endsWith(".resolved")) return 2;
  return 1;
}

/**
 * The transcript's order: `compareThreadActivities`, except that activities recorded in the same
 * instant follow their lifecycle (a request before its resolution) before the id decides.
 */
export function compareThreadActivitiesInLifecycleOrder(
  left: ThreadActivityOrderKey & { readonly kind: string },
  right: ThreadActivityOrderKey & { readonly kind: string },
): number {
  return (
    compareThreadActivitySequence(left, right) ||
    left.createdAt.localeCompare(right.createdAt) ||
    threadActivityLifecycleRank(left.kind) - threadActivityLifecycleRank(right.kind) ||
    left.id.localeCompare(right.id)
  );
}

// ── Changed files in tool payloads ────────────────────────────────────

/** Keys that name a file in a tool payload record, in lookup order. */
export const CHANGED_FILE_PATH_KEYS = [
  "path",
  "filePath",
  "relativePath",
  "filename",
  "newPath",
  "oldPath",
] as const;

/** Keys whose values may nest further file records, in scan order. */
export const CHANGED_FILE_NESTED_KEYS = [
  "item",
  "result",
  "input",
  "data",
  "changes",
  "files",
  "edits",
  "patch",
  "patches",
  "operations",
] as const;

/** How deep a payload is scanned for file records. */
export const CHANGED_FILE_SCAN_MAX_DEPTH = 4;

/** How many files a payload scan collects before it stops. */
export const CHANGED_FILE_SCAN_MAX_FILES = 12;

function asPayloadRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pushChangedFile(target: string[], seen: Set<string>, value: unknown): void {
  if (typeof value !== "string") return;
  const normalized = value.trim();
  if (normalized.length === 0 || seen.has(normalized)) return;
  seen.add(normalized);
  target.push(normalized);
}

/**
 * Collects the distinct file paths a tool payload names into `target`, scanning nested
 * records and arrays up to `CHANGED_FILE_SCAN_MAX_DEPTH` and stopping at
 * `CHANGED_FILE_SCAN_MAX_FILES`. The server's activity projection and every client's work log
 * read file changes through this one scan.
 */
export function collectChangedFiles(
  value: unknown,
  target: string[],
  seen: Set<string>,
  depth: number,
): void {
  if (depth > CHANGED_FILE_SCAN_MAX_DEPTH || target.length >= CHANGED_FILE_SCAN_MAX_FILES) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectChangedFiles(entry, target, seen, depth + 1);
      if (target.length >= CHANGED_FILE_SCAN_MAX_FILES) return;
    }
    return;
  }

  const record = asPayloadRecord(value);
  if (!record) return;

  for (const key of CHANGED_FILE_PATH_KEYS) {
    pushChangedFile(target, seen, record[key]);
  }
  for (const nestedKey of CHANGED_FILE_NESTED_KEYS) {
    if (!(nestedKey in record)) continue;
    collectChangedFiles(record[nestedKey], target, seen, depth + 1);
    if (target.length >= CHANGED_FILE_SCAN_MAX_FILES) return;
  }
}

// ── Checkpoint revert retention ───────────────────────────────────────

/**
 * Decides whether an item bound to a turn survives a revert. The legacy rule keeps only turns
 * with a retained checkpoint; the authoritative rule (events that carry `latestTurn`) also keeps
 * items of turns that are not dropped and predate the kept boundary, which a hydrated command
 * model has no checkpoints for.
 */
export type RevertTurnItemFilter = (item: {
  readonly turnId: string;
  readonly createdAt: string;
}) => boolean;

export interface RevertRetentionInput {
  /** Turns whose checkpoints the revert keeps. */
  readonly retainedTurnIds: Iterable<string>;
  /**
   * The authoritative latest turn the revert leaves, null for none. Undefined for events that
   * predate it, which keep the count-based rule.
   */
  readonly latestTurn?:
    | { readonly turnId: string; readonly completedAt: string | null }
    | null
    | undefined;
  /** Authoritative turns the revert drops; only read together with `latestTurn`. */
  readonly droppedTurnIds?: ReadonlyArray<string> | undefined;
}

export interface RevertRetention {
  readonly keepTurnItem: RevertTurnItemFilter;
  /**
   * Authoritative boundary: count-based fallback candidates must not postdate it, and null
   * keeps none. Undefined when the legacy rule applies.
   */
  readonly boundaryAt: string | null | undefined;
}

/** The one revert-retention rule the server's projection and every client's store apply. */
export function resolveRevertRetention(input: RevertRetentionInput): RevertRetention {
  const retainedTurnIds = new Set<string>(input.retainedTurnIds);
  const { latestTurn } = input;
  if (latestTurn === undefined) {
    return {
      keepTurnItem: (item) => retainedTurnIds.has(item.turnId),
      boundaryAt: undefined,
    };
  }

  if (latestTurn !== null) retainedTurnIds.add(latestTurn.turnId);
  const dropped = new Set<string>(input.droppedTurnIds ?? []);
  const boundary = latestTurn?.completedAt ?? null;
  return {
    keepTurnItem: (item) =>
      retainedTurnIds.has(item.turnId) ||
      (!dropped.has(item.turnId) && boundary !== null && item.createdAt <= boundary),
    boundaryAt: boundary,
  };
}

interface RevertableMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly turnId?: string | null | undefined;
  readonly createdAt: string;
}

function compareByCreatedAtThenId(
  left: { readonly id: string; readonly createdAt: string },
  right: { readonly id: string; readonly createdAt: string },
): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

/**
 * The messages that survive a revert to `turnCount` checkpoints: system messages, messages of
 * kept turns, and, for each role still short of `turnCount`, the oldest turn-less or kept
 * messages that do not postdate `boundaryAt`.
 */
export function retainThreadMessagesAfterRevert<M extends RevertableMessage>(
  messages: ReadonlyArray<M>,
  keepTurnItem: RevertTurnItemFilter,
  turnCount: number,
  /** Authoritative boundary: fallback candidates must not postdate it. Null keeps none. */
  boundaryAt?: string | null,
): M[] {
  const retainedMessageIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.id);
      continue;
    }
    if (
      message.turnId !== undefined &&
      message.turnId !== null &&
      keepTurnItem({ turnId: message.turnId, createdAt: message.createdAt })
    ) {
      retainedMessageIds.add(message.id);
    }
  }
  const isFallbackCandidate = (message: M) =>
    (message.turnId === undefined ||
      message.turnId === null ||
      keepTurnItem({ turnId: message.turnId, createdAt: message.createdAt })) &&
    (boundaryAt === undefined || (boundaryAt !== null && message.createdAt <= boundaryAt));

  for (const role of ["user", "assistant"] as const) {
    const retainedCount = messages.filter(
      (message) => message.role === role && retainedMessageIds.has(message.id),
    ).length;
    const missingCount = Math.max(0, turnCount - retainedCount);
    if (missingCount === 0) continue;
    const fallbackMessages = messages
      .filter(
        (message) =>
          message.role === role &&
          !retainedMessageIds.has(message.id) &&
          isFallbackCandidate(message),
      )
      .toSorted(compareByCreatedAtThenId)
      .slice(0, missingCount);
    for (const message of fallbackMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.id));
}

/**
 * `retainThreadMessagesAfterRevert` for a thread that may be a fork. A fork's inherited history
 * predates every checkpoint the fork owns, so it always stays; it is kept apart from the
 * count-based fallback, which only ever fills in the fork's own messages.
 */
export function retainThreadMessagesAfterForkRevert<M extends RevertableMessage>(
  threadId: string,
  messages: ReadonlyArray<M>,
  keepTurnItem: RevertTurnItemFilter,
  turnCount: number,
  boundaryAt?: string | null,
): M[] {
  const ownMessages = retainThreadMessagesAfterRevert(
    messages.filter((message) => !isForkBaseItemId(threadId, message.id)),
    keepTurnItem,
    turnCount,
    boundaryAt,
  );
  const keptOwnMessageIds = new Set(ownMessages.map((message) => message.id));
  return messages.filter(
    (message) => isForkBaseItemId(threadId, message.id) || keptOwnMessageIds.has(message.id),
  );
}

/** Proposed plans and activities that survive a revert: turn-less, fork base, or kept turns. */
export function retainTurnItemsAfterRevert<
  T extends { readonly id: string; readonly turnId: string | null; readonly createdAt: string },
>(threadId: string, items: ReadonlyArray<T>, keepTurnItem: RevertTurnItemFilter): T[] {
  return items.filter(
    (item) =>
      item.turnId === null ||
      isForkBaseItemId(threadId, item.id) ||
      keepTurnItem({ turnId: item.turnId, createdAt: item.createdAt }),
  );
}
