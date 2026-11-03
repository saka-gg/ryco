/**
 * The orchestration side of pull request watches: what a `thread.pull-request-watch.update`
 * may change (the decider's fence), the ids the watch service mints for it, and how many
 * refused updates in a row end a watch. Pure and small: it sits on the boot path with the
 * decider, so it never imports the decision rules (`@ryco/shared/pullRequestWatch`).
 */
import {
  CommandId,
  MessageId,
  PULL_REQUEST_WATCH_WAKE_MESSAGE_PREFIX,
  type OrchestrationReadModel,
  type ThreadId,
  type ThreadPullRequestWatches,
  type ThreadPullRequestWatchUpdateCommand,
} from "@ryco/contracts";
import {
  EMPTY_PULL_REQUEST_WATCHES,
  endPullRequestWatches,
  PULL_REQUEST_WATCH_MAX_REJECTED_UPDATES,
  PULL_REQUEST_WATCHES_PER_THREAD,
  upsertPullRequestWatch,
} from "@ryco/shared/pullRequestWatchSummary";

import { findWorktreeById, isThreadLive, threadLifecycleTurnBlocker } from "./commandInvariants.ts";

type Thread = OrchestrationReadModel["threads"][number];

/**
 * The refusal of an update derived from a watch that changed since it was read (another
 * pass, the user's switch, or a stop and restart). Not a delivery failure: the next pass
 * reads the current watch.
 */
export const PULL_REQUEST_WATCH_CHANGED_DETAIL =
  "The pull request watch changed while it was read.";

export const pullRequestWatchesOf = (thread: Thread): ThreadPullRequestWatches =>
  thread.pullRequestWatchState ?? EMPTY_PULL_REQUEST_WATCHES;

/** Why the update cannot apply to `thread`, or null when it may. */
export function pullRequestWatchUpdateBlocker(
  readModel: OrchestrationReadModel,
  thread: Thread,
  command: ThreadPullRequestWatchUpdateCommand,
): string | null {
  const watches = pullRequestWatchesOf(thread);
  const current = watches.active.find((watch) => watch.watchId === command.watchId);
  // The epoch: an update names the revision and the generation it was derived from, so two
  // passes, a held wake and a sweep, or a pass and a stop-and-restart never both apply.
  if (command.expectedRevision === null || command.expectedStartedAt === null) {
    if (command.expectedRevision !== null || command.expectedStartedAt !== null) {
      return "A new pull request watch names neither a revision nor a start.";
    }
    if (current !== undefined) return PULL_REQUEST_WATCH_CHANGED_DETAIL;
  } else if (
    current === undefined ||
    current.revision !== command.expectedRevision ||
    current.startedAt !== command.expectedStartedAt
  ) {
    return PULL_REQUEST_WATCH_CHANGED_DETAIL;
  }

  const next = command.next;
  if (next === null) {
    if (current === undefined) return "Only an active pull request watch can end.";
    if (command.endReason === undefined) return "An ended pull request watch needs a reason.";
  } else {
    if (command.endReason !== undefined) return "An active pull request watch has no end reason.";
    if (next.watchId !== command.watchId) return "The pull request watch changed its id.";
    if (next.revision !== (current?.revision ?? 0) + 1) {
      return "A pull request watch moves one revision at a time.";
    }
    if (current !== undefined && next.startedAt !== current.startedAt) {
      return PULL_REQUEST_WATCH_CHANGED_DETAIL;
    }
    if (current === undefined) {
      // A watch that could never deliver is refused here, where it is atomic with the lifecycle
      // commands that end watches (Trash, checkout removal), rather than left to a later read.
      const lifecycleBlocker = threadLifecycleTurnBlocker(readModel, thread);
      if (lifecycleBlocker !== null) return lifecycleBlocker;
      // A chat may watch a pull request of any workspace in its own project.
      const workspace = findWorktreeById(readModel, next.worktreeId);
      if (workspace?.projectId !== thread.projectId) {
        return "The pull request belongs to a workspace of another project.";
      }
      if (workspace.checkoutRemovedAt != null) {
        return "The pull request's workspace has no checkout to read it from.";
      }
      if (watches.active.length >= PULL_REQUEST_WATCHES_PER_THREAD) {
        return `A chat watches at most ${PULL_REQUEST_WATCHES_PER_THREAD} pull requests.`;
      }
    }
  }

  // A watch that stays active, and any wake, need a chat that takes work (an end needs neither).
  const wake = command.wake;
  if (next !== null || wake !== undefined) {
    if (!isThreadLive(thread) || thread.archivedAt !== null) {
      return "Archived, trashed and deleted chats do not watch pull requests.";
    }
    if (thread.settledOverride === "settled") {
      return "A settled chat does not watch pull requests. Make it active first.";
    }
  }
  if (wake !== undefined) {
    if (!wake.messageId.startsWith(PULL_REQUEST_WATCH_WAKE_MESSAGE_PREFIX)) {
      return "A pull request update carries a pull request watch message id.";
    }
    // The wake the watch records as pending must be this one.
    if (next !== null && next.delivery?.messageId !== wake.messageId) {
      return "The pull request watch does not record this update as sent.";
    }
    // An Auto-fix CI turn in plan or ask mode cannot edit and would spend an attempt.
    if (next?.delivery?.kind === "fix" && thread.interactionMode !== "default") {
      return "The chat left its default mode while this Auto-fix CI turn was prepared.";
    }
  }
  return null;
}

/** The thread's watches after an update `pullRequestWatchUpdateBlocker` accepted. */
export function pullRequestWatchesAfterUpdate(
  thread: Thread,
  command: ThreadPullRequestWatchUpdateCommand,
): ThreadPullRequestWatches {
  const watches = pullRequestWatchesOf(thread);
  return command.next === null
    ? endPullRequestWatches(watches, {
        watchIds: new Set([command.watchId]),
        // The blocker requires a reason for an end.
        reason: command.endReason ?? "unwatched",
        endedAt: command.createdAt,
      })
    : upsertPullRequestWatch(watches, command.next);
}

/** A fresh command id per update: a rejected receipt never poisons a later retry of the same revision. */
export const pullRequestWatchUpdateCommandId = (input: {
  readonly threadId: ThreadId;
  readonly watchId: string;
  readonly revision: number;
}): CommandId =>
  CommandId.make(
    `server:pr-watch:${input.threadId}:${input.watchId}:${input.revision}:${crypto.randomUUID()}`,
  );

/** A wake's message id, under the reserved prefix that tells it apart from the user's messages. */
export const pullRequestWatchWakeMessageId = (threadId: ThreadId): MessageId =>
  MessageId.make(`${PULL_REQUEST_WATCH_WAKE_MESSAGE_PREFIX}${threadId}:${crypto.randomUUID()}`);

/** One watch generation (`startedAt`) of one thread. */
export interface PullRequestWatchGeneration {
  readonly threadId: ThreadId;
  readonly watchId: string;
  readonly startedAt: string;
}

export interface PullRequestWatchRejections {
  /**
   * Counts a refused update that carried a wake. True once `PULL_REQUEST_WATCH_MAX_REJECTED_UPDATES`
   * were refused in a row: the watch service then ends the watch as `rejected` (an end without a
   * wake is never refused for delivery reasons). A refusal with
   * {@link PULL_REQUEST_WATCH_CHANGED_DETAIL} is a stale read, not a refusal, and is not counted.
   */
  readonly noteRefused: (generation: PullRequestWatchGeneration, detail: string) => boolean;
  /** An accepted update starts the count again. */
  readonly noteAccepted: (generation: PullRequestWatchGeneration) => void;
  /** The generation ended; drop its count. */
  readonly forget: (generation: PullRequestWatchGeneration) => void;
}

/**
 * In memory, like the forge read cache: a restart starts every count again, so a watch whose
 * updates keep failing ends at most `PULL_REQUEST_WATCH_MAX_REJECTED_UPDATES` refusals after it.
 */
export function makePullRequestWatchRejections(): PullRequestWatchRejections {
  const refused = new Map<string, number>();
  const keyOf = (generation: PullRequestWatchGeneration) =>
    `${generation.threadId}\u0000${generation.watchId}\u0000${generation.startedAt}`;
  return {
    noteRefused: (generation, detail) => {
      if (detail === PULL_REQUEST_WATCH_CHANGED_DETAIL) return false;
      const key = keyOf(generation);
      const count = (refused.get(key) ?? 0) + 1;
      refused.set(key, count);
      return count >= PULL_REQUEST_WATCH_MAX_REJECTED_UPDATES;
    },
    noteAccepted: (generation) => {
      refused.delete(keyOf(generation));
    },
    forget: (generation) => {
      refused.delete(keyOf(generation));
    },
  };
}
