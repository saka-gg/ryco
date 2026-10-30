/**
 * Server wakes: queued turn starts the server sends on its own, with no person at the keyboard
 * (delegated results, pull request watch updates, goal continuations, the thread's own queued
 * follow-ups). Pure rules and wording shared by every wake source, the decider and the provider
 * reactor. The stateful part (pending-start sightings, the cold-start budget) is
 * `ServerWakeFence`.
 *
 * Pure module: no services, no I/O.
 *
 * @module serverWake
 */
import type {
  DelegationReturnGuard,
  MessageId,
  OrchestrationThreadShell,
  RuntimeMode,
  ServerWakeSource,
  ThreadFollowUpQueue,
  ThreadFollowUpQueueShell,
} from "@ryco/contracts";
import { RUNTIME_MODE_RANK } from "@ryco/shared/runtimeMode";
import type { QueuedTurnIdleInput } from "@ryco/shared/threadSettlement";

/**
 * Cold wakes start a session for their thread. The reactor runs each thread in its own lane,
 * so they no longer block other threads; the cap matches the default concurrent provider
 * starts per instance, which avoids admission-busy failures in post-restart bursts. One budget
 * per process, shared by every wake source.
 */
export const MAX_COLD_WAKES_IN_FLIGHT = 4;
/** A cold slot is released after this long even when its start never bound nor failed. */
export const COLD_WAKE_GRACE_MS = 120_000;

/** Privilege order of runtime modes: lower is less privileged. */
export const runtimeModePrivilegeRank = RUNTIME_MODE_RANK;

/** The wake source a turn start's guard names; null for a turn start without a guard. */
export const serverWakeSource = (
  guard: Pick<DelegationReturnGuard, "source"> | undefined,
): ServerWakeSource | null => (guard === undefined ? null : (guard.source ?? "delegation-return"));

/** The wording for a guarded wake (an absent source is a delegated result). */
export const serverWakeCopy = (guard: Pick<DelegationReturnGuard, "source">): ServerWakeCopy =>
  SERVER_WAKE_COPY[guard.source ?? "delegation-return"];

/**
 * An unattended, untrusted-content-triggered turn never runs with more privilege or in a
 * different checkout than the one the wake was set up for. Lowering privilege is fine.
 */
export const serverWakeInScope = (
  captured: { readonly runtimeMode: RuntimeMode; readonly worktreePath: string | null },
  shell: Pick<OrchestrationThreadShell, "runtimeMode" | "worktreePath">,
): boolean =>
  runtimeModePrivilegeRank[shell.runtimeMode] <= runtimeModePrivilegeRank[captured.runtimeMode] &&
  shell.worktreePath === captured.worktreePath;

/**
 * The decider's fence for a wake built from `shell`. A delegated result's guard carries no
 * `source`, so its command (and the stored event) is unchanged.
 */
export const serverWakeGuard = (
  shell: Pick<OrchestrationThreadShell, "projectId" | "runtimeMode" | "worktreePath">,
  latestUserMessageId: MessageId | null,
  source: ServerWakeSource,
): DelegationReturnGuard => ({
  latestUserMessageId,
  projectId: shell.projectId,
  runtimeMode: shell.runtimeMode,
  worktreePath: shell.worktreePath,
  ...(source === "delegation-return" ? {} : { source }),
});

/** What the wake rules read of a thread's follow-up queue: a shell, or `followUpQueueWakeView`. */
interface FollowUpQueueWakeView {
  readonly followUpQueueSummary?: Pick<ThreadFollowUpQueueShell, "hold" | "headStatus">;
}

/**
 * The decider's view of a thread's queue in the shell's terms: absent while it has no entry,
 * even when held, like the shell's summary.
 */
export const followUpQueueWakeView = (
  queue: ThreadFollowUpQueue | undefined,
): FollowUpQueueWakeView => {
  const head = queue?.entries[0];
  return queue === undefined || head === undefined
    ? {}
    : { followUpQueueSummary: { hold: queue.hold, headStatus: head.status } };
};

/**
 * A follow-up queue that will send its head at the next idle edge: non-empty, not held, its head
 * ready. While one waits, other wake sources wait behind it, so the user's own follow-ups go
 * first; a held queue (or one whose head waits for Retry) blocks nothing.
 */
export const followUpQueueWaiting = (shell: FollowUpQueueWakeView) =>
  shell.followUpQueueSummary !== undefined &&
  shell.followUpQueueSummary.hold === null &&
  shell.followUpQueueSummary.headStatus === "queued";

/**
 * Whether the thread's follow-up queue keeps a wake from `source` waiting: every other source
 * waits while the queue will send its head. A goal's next turn also waits while queued
 * follow-ups sit held or wait for Retry, so automatic goal turns never run past messages the
 * person queued. `ServerWakeFence` asks before a wake is sent, and the decider asks again when
 * it is, so a follow-up queued in between still goes first.
 */
export const followUpQueueHoldsWake = (
  shell: FollowUpQueueWakeView,
  source: ServerWakeSource | undefined,
): boolean =>
  source === "follow-up-queue"
    ? false
    : source === "goal-continuation"
      ? shell.followUpQueueSummary !== undefined
      : followUpQueueWaiting(shell);

/** Decider: a follow-up was queued after the wake's source checked the fence. */
export const SERVER_WAKE_QUEUE_FIRST =
  "The chat's queued follow-ups go first. This waits until they are sent.";

/** The shared queued-turn idle rule's input, read from a thread shell. */
export const queuedTurnIdleInputFromShell = (
  shell: OrchestrationThreadShell,
  nowMs: number,
): QueuedTurnIdleInput => ({
  archivedAt: shell.archivedAt,
  sessionStatus: shell.session?.status ?? null,
  latestTurnState: shell.latestTurn?.state ?? null,
  latestTurnRequestedAt: shell.latestTurn?.requestedAt ?? null,
  latestUserMessageAt: shell.latestUserMessageAt,
  hasPendingApprovals: shell.hasPendingApprovals,
  hasPendingUserInput: shell.hasPendingUserInput,
  backgroundLiveness: shell.backgroundLiveness ?? null,
  nowMs,
});

interface ServerWakeNotice {
  readonly summary: string;
  readonly detail: string;
}

/** What the user reads when a wake of this source is refused or cut off. */
export interface ServerWakeCopy {
  /** Decider: the thread changed between the fence check and the dispatch. */
  readonly originChanged: string;
  /** Decider: a usage limit applies (a race with a new limit; the fence holds wakes before). */
  readonly usageLimited: string;
  /** Reactor: a wake never starts a model handoff. */
  readonly handoffRefused: ServerWakeNotice;
  /** Restart recovery: the start was never handed to the provider. */
  readonly notSent: ServerWakeNotice;
  /** Restart recovery: the provider may have received the start. */
  readonly uncertain: ServerWakeNotice;
}

export const SERVER_WAKE_COPY: Record<ServerWakeSource, ServerWakeCopy> = {
  "delegation-return": {
    originChanged:
      "Delegated result origin changed. Open the child task and return its result manually.",
    usageLimited:
      "The originating chat hit its usage limit. The delegated result waits until it is resumed.",
    handoffRefused: {
      summary: "Delegated return was not submitted",
      detail:
        "A delegated result cannot start a model handoff. Inspect this result before sending it manually.",
    },
    notSent: {
      summary: "Delegated return was not submitted",
      detail:
        "Ryco restarted before this delegated result reached the provider. Inspect the result before sending it manually.",
    },
    uncertain: {
      summary: "Delegated return delivery unconfirmed",
      detail:
        "Ryco restarted while submitting this delegated result. It may have reached the provider. Inspect the parent thread before sending it manually.",
    },
  },
  "follow-up-queue": {
    originChanged: "The chat changed while this queued message was being sent. It stays queued.",
    usageLimited: "The chat hit its usage limit. The queued message waits until it is resumed.",
    // Unreachable: a queued message may change the model, and its handoff runs like a send's.
    handoffRefused: {
      summary: "Queued message was not sent",
      detail: "This queued message could not start a model handoff. Send it again.",
    },
    notSent: {
      summary: "Queued message was not sent",
      detail:
        "Ryco restarted before this queued message reached the provider. Nothing was sent. Send it again to continue.",
    },
    uncertain: {
      summary: "Queued message delivery unconfirmed",
      detail:
        "Ryco restarted while sending this queued message. It may have been received. Check the chat before sending it again.",
    },
  },
  "pull-request-watch": {
    originChanged: "The chat changed while this pull request update was prepared.",
    usageLimited:
      "The chat hit its usage limit. The pull request update waits until it is resumed.",
    handoffRefused: {
      summary: "Pull request update was not sent",
      detail: "A pull request update cannot start a model handoff. Nothing was sent to the agent.",
    },
    notSent: {
      summary: "Pull request update was not sent",
      detail:
        "Ryco restarted before this pull request update reached the agent. Nothing was sent. Ryco checks the pull request again and reports what is still new.",
    },
    uncertain: {
      summary: "Pull request update delivery unconfirmed",
      detail:
        "Ryco restarted while sending this pull request update. It may have reached the agent. Check the chat before acting on it again.",
    },
  },
  "goal-continuation": {
    originChanged: "The chat changed before the goal's next turn started.",
    usageLimited: "The chat hit its usage limit. The goal continues after it is resumed.",
    handoffRefused: {
      summary: "Goal turn was not started",
      detail: "The goal's next turn cannot start a model handoff. Nothing was sent to the agent.",
    },
    notSent: {
      summary: "Goal turn was not started",
      detail:
        "Ryco restarted before the goal's next turn reached the agent. Nothing was sent. Send a message to keep working toward the goal.",
    },
    uncertain: {
      summary: "Goal turn delivery unconfirmed",
      detail:
        "Ryco restarted while starting the goal's next turn. It may have reached the agent. Check the chat before continuing.",
    },
  },
};
