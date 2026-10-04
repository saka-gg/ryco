import type {
  OrchestrationLatestTurnState,
  OrchestrationSessionStatus,
  OrchestrationThreadActivity,
  ScopedThreadRef,
  ThreadUsageLimit,
  TurnId,
} from "@ryco/contracts";

import type { TurnSteerRejectionActivity } from "@ryco/shared/turnSteer";

import { derivePendingApprovals, derivePendingUserInputs } from "../session/session-logic.ts";
import { indexTurnSteerRejections } from "./logic.ts";
import { selectEnvironmentState, type AppState } from "../threads/store.ts";
import { selectThreadDetailLoaded } from "../threads/storeSelectors.ts";

/**
 * The queue's read of one thread: everything the drain policy needs, and
 * nothing it doesn't. Platform-neutral so web and mobile share one policy.
 */
export interface QueueThreadView {
  readonly ref: ScopedThreadRef;
  /** A turn, a projected message, or a sidebar user message exists. */
  readonly started: boolean;
  /** The thread or its worktree is archived. */
  readonly archived: boolean;
  /** A thread-detail window or full-detail snapshot has been applied. */
  readonly detailLoaded: boolean;
  /**
   * Same overlap window as mobile's `threadBusy`, plus a `starting` session; a
   * `running` turn row the session has already released does not count.
   */
  readonly running: boolean;
  readonly hasPendingApproval: boolean;
  readonly hasPendingUserInput: boolean;
  readonly session: {
    readonly status: OrchestrationSessionStatus;
    readonly lastError: string | null;
    readonly providerInstanceId: string | null;
    readonly activeTurnId: TurnId | null;
  } | null;
  readonly latestTurn: {
    readonly turnId: TurnId;
    readonly state: OrchestrationLatestTurnState;
  } | null;
  /**
   * The latest turn's checkpoint is the provider-diff placeholder recorded on
   * its first diff update. Its `missing` status reads as an `interrupted`
   * latest turn although nobody stopped it, until the real capture replaces it
   * (which can fail). Only known once detail is loaded.
   */
  readonly latestTurnPlaceholderCheckpoint: boolean;
  readonly projectedMessageIds: ReadonlySet<string>;
  readonly turnStartFailures: ReadonlyArray<QueueTurnStartFailure>;
  /** Steer rejection rows keyed by activity id: one per steer request (`commandId`). */
  readonly steerRejectionsByActivityId: ReadonlyMap<string, TurnSteerRejectionActivity>;
  /**
   * Messages whose turn start a Stop cancelled before the provider took it
   * (`provider.turn.start.cancelled`). Settled, not failed: the Stop already
   * placed its own hold.
   */
  readonly turnStartCancelledMessageIds: ReadonlySet<string>;
  /** The projected usage limit; it only holds while `modelSelection` targets its instance. */
  readonly usageLimit?: ThreadUsageLimit | null | undefined;
  readonly modelSelection?: { readonly instanceId: string } | null | undefined;
}

export interface QueueTurnStartFailure {
  readonly activityId: string;
  readonly messageId: string;
  readonly detail: string | null;
}

interface ActivityDerivedView {
  readonly turnStartFailures: ReadonlyArray<QueueTurnStartFailure>;
  readonly steerRejectionsByActivityId: ReadonlyMap<string, TurnSteerRejectionActivity>;
  readonly turnStartCancelledMessageIds: ReadonlySet<string>;
  readonly pendingApproval: boolean;
  readonly pendingUserInput: boolean;
}

/**
 * `ProviderRuntimeIngestion` dispatches a `missing` checkpoint with this ref on a
 * turn's first `turn.diff.updated`, before `CheckpointReactor` captures the
 * real one.
 */
const PLACEHOLDER_CHECKPOINT_REF_PREFIX = "provider-diff:";

const EMPTY_MESSAGE_ID_SET: ReadonlySet<string> = new Set();
const EMPTY_ACTIVITY_VIEW: ActivityDerivedView = {
  turnStartFailures: [],
  steerRejectionsByActivityId: indexTurnSteerRejections([]),
  turnStartCancelledMessageIds: EMPTY_MESSAGE_ID_SET,
  pendingApproval: false,
  pendingUserInput: false,
};

// Streaming deltas replace `messageByThreadId` but not the ids array, so the
// projected-id set is recomputed only when a message is added or removed.
const projectedMessageIdCache = new WeakMap<readonly string[], ReadonlySet<string>>();
// Keyed by the activity record rather than the ids array: an in-place activity
// update replaces the record but keeps the ids array.
const activityViewCache = new WeakMap<
  Record<string, OrchestrationThreadActivity>,
  ActivityDerivedView
>();

function readProjectedMessageIds(ids: readonly string[] | undefined): ReadonlySet<string> {
  if (!ids || ids.length === 0) return EMPTY_MESSAGE_ID_SET;
  const cached = projectedMessageIdCache.get(ids);
  if (cached) return cached;
  const next = new Set(ids);
  projectedMessageIdCache.set(ids, next);
  return next;
}

function readPayloadString(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

function readActivityView(
  ids: readonly string[] | undefined,
  byId: Record<string, OrchestrationThreadActivity> | undefined,
): ActivityDerivedView {
  if (!ids || ids.length === 0 || !byId) return EMPTY_ACTIVITY_VIEW;
  const cached = activityViewCache.get(byId);
  if (cached) return cached;
  const activities: OrchestrationThreadActivity[] = [];
  const turnStartFailures: QueueTurnStartFailure[] = [];
  const turnStartCancelledMessageIds = new Set<string>();
  for (const id of ids) {
    const activity = byId[id];
    if (!activity) continue;
    activities.push(activity);
    if (activity.kind === "provider.turn.start.failed") {
      const messageId = readPayloadString(activity.payload, "messageId");
      if (messageId !== null) {
        turnStartFailures.push({
          activityId: activity.id,
          messageId,
          detail: readPayloadString(activity.payload, "detail"),
        });
      }
    } else if (activity.kind === "provider.turn.start.cancelled") {
      const messageId = readPayloadString(activity.payload, "messageId");
      if (messageId !== null) turnStartCancelledMessageIds.add(messageId);
    }
  }
  const next: ActivityDerivedView = {
    turnStartFailures,
    steerRejectionsByActivityId: indexTurnSteerRejections(activities),
    turnStartCancelledMessageIds:
      turnStartCancelledMessageIds.size > 0 ? turnStartCancelledMessageIds : EMPTY_MESSAGE_ID_SET,
    pendingApproval: derivePendingApprovals(activities).length > 0,
    pendingUserInput: derivePendingUserInputs(activities).length > 0,
  };
  activityViewCache.set(byId, next);
  return next;
}

/**
 * A turn row can stay `running` after its session has settled (`ready` or
 * `error` with no active turn): non-git tool-only turns, a failed checkpoint
 * capture and ACP prompt failures leave it unfinalized. Waiting on such a turn
 * would strand the queue as `busy`, where no Resume can move it. The session
 * counts as having released the turn only when it was updated after the turn
 * started; an older session update is stale ordering, not a release.
 */
function sessionReleasedTurn(
  session: { readonly updatedAt: string } | null,
  latestTurn: { readonly requestedAt: string; readonly startedAt: string | null },
): boolean {
  if (session === null) return false;
  return Date.parse(session.updatedAt) > Date.parse(latestTurn.startedAt ?? latestTurn.requestedAt);
}

function isPlaceholderCheckpoint(
  summary:
    | { readonly status?: string | undefined; readonly checkpointRef?: string | undefined }
    | undefined,
): boolean {
  return (
    summary?.status === "missing" &&
    (summary.checkpointRef?.startsWith(PLACEHOLDER_CHECKPOINT_REF_PREFIX) ?? false)
  );
}

/** null when the environment has no shell for the thread. */
export function readQueueThreadView(state: AppState, ref: ScopedThreadRef): QueueThreadView | null {
  const environmentState = selectEnvironmentState(state, ref.environmentId);
  const threadId = ref.threadId;
  const shell = environmentState.threadShellById[threadId];
  if (!shell) return null;

  const session = environmentState.threadSessionById[threadId] ?? null;
  const latestTurn = environmentState.threadTurnStateById[threadId]?.latestTurn ?? null;
  const summary = environmentState.sidebarThreadSummaryById[threadId];
  const messageIds = environmentState.messageIdsByThreadId[threadId];
  const detailLoaded = selectThreadDetailLoaded(state, ref);
  const activityView = detailLoaded
    ? readActivityView(
        environmentState.activityIdsByThreadId[threadId],
        environmentState.activityByThreadId[threadId],
      )
    : EMPTY_ACTIVITY_VIEW;
  const worktree = shell.worktreeId
    ? environmentState.worktreeById?.[
        shell.worktreeId as keyof typeof environmentState.worktreeById
      ]
    : undefined;
  const orchestrationStatus = session?.orchestrationStatus ?? null;

  return {
    ref,
    started:
      latestTurn !== null ||
      (messageIds?.length ?? 0) > 0 ||
      (summary?.latestUserMessageAt ?? null) !== null,
    archived: shell.archivedAt !== null || (worktree?.archivedAt ?? null) !== null,
    detailLoaded,
    running:
      orchestrationStatus === "running" ||
      orchestrationStatus === "starting" ||
      Boolean(session?.activeTurnId) ||
      (latestTurn?.state === "running" && !sessionReleasedTurn(session, latestTurn)),
    hasPendingApproval: Boolean(summary?.hasPendingApprovals) || activityView.pendingApproval,
    hasPendingUserInput: Boolean(summary?.hasPendingUserInput) || activityView.pendingUserInput,
    session: session
      ? {
          status: session.orchestrationStatus,
          lastError: session.lastError ?? null,
          providerInstanceId: session.providerInstanceId ?? null,
          activeTurnId: session.activeTurnId ?? null,
        }
      : null,
    latestTurn: latestTurn ? { turnId: latestTurn.turnId, state: latestTurn.state } : null,
    latestTurnPlaceholderCheckpoint: isPlaceholderCheckpoint(
      latestTurn
        ? environmentState.turnDiffSummaryByThreadId[threadId]?.[latestTurn.turnId]
        : undefined,
    ),
    projectedMessageIds: readProjectedMessageIds(messageIds),
    turnStartFailures: activityView.turnStartFailures,
    steerRejectionsByActivityId: activityView.steerRejectionsByActivityId,
    turnStartCancelledMessageIds: activityView.turnStartCancelledMessageIds,
    usageLimit: shell.usageLimit ?? null,
    modelSelection: shell.modelSelection,
  };
}

/**
 * Identity tuple for change detection: equal tuples ⇒ equal views (and equal
 * environment shell readiness). Unrelated threads cost one tuple compare.
 */
export function queueThreadViewInputs(state: AppState, ref: ScopedThreadRef): readonly unknown[] {
  const environmentState = selectEnvironmentState(state, ref.environmentId);
  const threadId = ref.threadId;
  const shell = environmentState.threadShellById[threadId];
  return [
    shell,
    environmentState.threadSessionById[threadId],
    environmentState.threadTurnStateById[threadId],
    environmentState.turnDiffSummaryByThreadId[threadId],
    environmentState.sidebarThreadSummaryById[threadId],
    environmentState.messageIdsByThreadId[threadId],
    environmentState.activityIdsByThreadId[threadId],
    environmentState.activityByThreadId[threadId],
    environmentState.threadHistoryByThreadId?.[threadId],
    shell?.worktreeId
      ? environmentState.worktreeById?.[
          shell.worktreeId as keyof typeof environmentState.worktreeById
        ]
      : undefined,
    environmentState.bootstrapComplete,
    environmentState.hydratedFromCacheAt,
  ];
}

export function queueThreadViewInputsEqual(
  left: readonly unknown[] | undefined,
  right: readonly unknown[],
): boolean {
  return (
    left !== undefined &&
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]))
  );
}
