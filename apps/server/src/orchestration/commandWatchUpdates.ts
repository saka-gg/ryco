/**
 * The orchestration side of command watches: what a `thread.command-watch.update` may change
 * (the decider's fence) and how lifecycle commands end a thread's watches. Loaded through
 * `commandWatchLoader.ts` on the first command watch update, or the first lifecycle command of
 * a chat that has a watch, so nodes whose agents never watch a command never load it.
 *
 * Imports no value from the boot graph: the loader hands over the helpers it needs.
 *
 * Trust boundary: the update is a server-only command (clients cannot send it), and this fence
 * is where every watch change is checked again, atomically with the lifecycle commands that end
 * watches. A watch is created only for a live, unarchived, unsettled chat in Full access and
 * default mode, with the chat's current runtime and checkout captured; what runs (the command,
 * its cwd, its cadence and that scope) never changes after; a watch that stays active, and any
 * wake, again needs that chat in Full access and default mode.
 *
 * @module commandWatchUpdates
 */
import type {
  CommandWatchEndReason,
  OrchestrationReadModel,
  ThreadCommandWatchStopCommand,
  ThreadCommandWatchUpdateCommand,
  ThreadCommandWatchUpdatedPayload,
  ThreadCommandWatches,
} from "@ryco/contracts";

import type { isThreadLive, threadLifecycleTurnBlocker } from "./commandInvariants.ts";

type Thread = OrchestrationReadModel["threads"][number];

/** What the boot side hands over (`commandWatchLoader.ts`). */
export interface CommandWatchHost {
  readonly isThreadLive: typeof isThreadLive;
  readonly threadLifecycleTurnBlocker: typeof threadLifecycleTurnBlocker;
  readonly wakeMessagePrefix: string;
  readonly perThread: number;
  readonly perNode: number;
  readonly wakesPerDay: number;
}

/**
 * The refusal of an update derived from a watch that changed since it was read (another run,
 * a stop, a stop and restart). Not a delivery failure: the next look reads the current watch.
 */
export const COMMAND_WATCH_CHANGED_DETAIL = "The command watch changed while it ran.";
/** Ended watches a thread keeps (newest first), for the agent's list and the user's detail. */
export const COMMAND_WATCH_ENDED_KEPT = 4;

const EMPTY: ThreadCommandWatches = { active: [], ended: [], recentWakes: [] };
const DAY_MS = 24 * 60 * 60_000;

/** The thread's wakes in the 24 hours before `nowIso` (the daily wake budget's window). */
export const recentCommandWatchWakes = (
  watches: ThreadCommandWatches,
  nowIso: string,
): ReadonlyArray<string> => {
  const since = Date.parse(nowIso) - DAY_MS;
  return watches.recentWakes.filter((at) => Date.parse(at) > since);
};

/**
 * Where the chat's commands run now: its checkout, else its project's root. A watch runs, and
 * wakes, only while this is still the directory it started in.
 */
const chatCwd = (readModel: OrchestrationReadModel, thread: Thread): string | null =>
  thread.worktreePath ??
  readModel.projects.find((project) => project.id === thread.projectId)?.workspaceRoot ??
  null;

export const commandWatchesOf = (thread: Thread): ThreadCommandWatches =>
  thread.commandWatchState ?? EMPTY;

/** Ends `watchIds` (every active watch when absent) with `reason`. */
export function endCommandWatches(
  watches: ThreadCommandWatches,
  input: {
    readonly watchIds?: ReadonlySet<string>;
    readonly reason: CommandWatchEndReason;
    readonly endedAt: string;
  },
): ThreadCommandWatches {
  const ending = watches.active.filter(
    (watch) => input.watchIds === undefined || input.watchIds.has(watch.watchId),
  );
  return {
    active: watches.active.filter((watch) => !ending.includes(watch)),
    ended: [
      ...ending.map((watch) => ({
        watchId: watch.watchId,
        label: watch.label,
        reason: input.reason,
        endedAt: input.endedAt,
      })),
      ...watches.ended,
    ].slice(0, COMMAND_WATCH_ENDED_KEPT),
    recentWakes: watches.recentWakes,
  };
}

/** Where command watches may run and wake: Full access and default mode (T3 Code). */
export const commandWatchScopeAllows = (
  thread: Pick<Thread, "runtimeMode" | "interactionMode">,
): boolean => thread.runtimeMode === "full-access" && thread.interactionMode === "default";

export function makeCommandWatchRules(host: CommandWatchHost) {
  /** Why the update cannot apply to `thread`, or null when it may. */
  const updateBlocker = (
    readModel: OrchestrationReadModel,
    thread: Thread,
    command: ThreadCommandWatchUpdateCommand,
  ): string | null => {
    const watches = commandWatchesOf(thread);
    const current = watches.active.find((watch) => watch.watchId === command.watchId);
    // The epoch: an update names the revision and the generation it was derived from.
    if (command.expectedRevision === null || command.expectedStartedAt === null) {
      if (command.expectedRevision !== null || command.expectedStartedAt !== null) {
        return "A new command watch names neither a revision nor a start.";
      }
      if (current !== undefined) return COMMAND_WATCH_CHANGED_DETAIL;
    } else if (
      current === undefined ||
      current.revision !== command.expectedRevision ||
      current.startedAt !== command.expectedStartedAt
    ) {
      return COMMAND_WATCH_CHANGED_DETAIL;
    }

    const next = command.next;
    if (next === null) {
      if (current === undefined) return "Only an active command watch can end.";
      if (command.endReason === undefined) return "An ended command watch needs a reason.";
    } else {
      if (command.endReason !== undefined) return "An active command watch has no end reason.";
      if (next.watchId !== command.watchId) return "The command watch changed its id.";
      if (next.revision !== (current?.revision ?? 0) + 1) {
        return "A command watch moves one revision at a time.";
      }
      if (current === undefined) {
        const lifecycleBlocker = host.threadLifecycleTurnBlocker(readModel, thread);
        if (lifecycleBlocker !== null) return lifecycleBlocker;
        // The captured scope is the chat's own, now: a wake never runs with more, and the
        // directory is the chat's, never one the agent named.
        if (
          next.runtimeMode !== thread.runtimeMode ||
          next.worktreePath !== thread.worktreePath ||
          next.cwd !== chatCwd(readModel, thread) ||
          next.lastOutputHash !== null ||
          next.wakes !== 0 ||
          next.delivery !== null
        ) {
          return "A new command watch starts from the chat's own scope, with no runs.";
        }
        if (watches.active.some((watch) => watch.command === next.command)) {
          return "This chat already watches that command.";
        }
        if (watches.active.length >= host.perThread) {
          return `A chat runs at most ${host.perThread} command watches.`;
        }
        let running = 0;
        for (const other of readModel.threads)
          running += other.commandWatchState?.active.length ?? 0;
        if (running >= host.perNode)
          return `This node runs at most ${host.perNode} command watches.`;
      } else if (
        // What runs, where, how often and with which authority never changes after the start.
        next.startedAt !== current.startedAt ||
        next.command !== current.command ||
        next.cwd !== current.cwd ||
        next.everyMinutes !== current.everyMinutes ||
        next.runtimeMode !== current.runtimeMode ||
        next.worktreePath !== current.worktreePath
      ) {
        return COMMAND_WATCH_CHANGED_DETAIL;
      }
    }

    // A watch that stays active, and any wake, need a chat that takes work in that scope (an
    // end needs neither).
    const wake = command.wake;
    if (next !== null || wake !== undefined) {
      if (!host.isThreadLive(thread) || thread.archivedAt !== null) {
        return "Archived, trashed and deleted chats run no command watches.";
      }
      if (thread.settledOverride === "settled") {
        return "A settled chat runs no command watches. Make it active first.";
      }
      if (!commandWatchScopeAllows(thread)) {
        return "Command watches need the chat in Full access and default mode.";
      }
      // A run that started before the chat moved to another checkout (or project root) never
      // records into, nor wakes, the chat where it is now.
      if (
        current !== undefined &&
        (thread.worktreePath !== current.worktreePath ||
          thread.runtimeMode !== current.runtimeMode ||
          chatCwd(readModel, thread) !== current.cwd)
      ) {
        return "The chat's checkout or permissions changed since the command watch started.";
      }
    }
    if (wake !== undefined) {
      if (recentCommandWatchWakes(watches, command.createdAt).length >= host.wakesPerDay) {
        return `This chat's command watches already woke it ${host.wakesPerDay} times in the last 24 hours.`;
      }
      if (!wake.messageId.startsWith(host.wakeMessagePrefix)) {
        return "A command watch update carries a command watch message id.";
      }
      if (next !== null && next.delivery?.messageId !== wake.messageId) {
        return "The command watch does not record this update as sent.";
      }
    }
    return null;
  };

  /** The thread's watches after an update `updateBlocker` accepted. */
  /** The daily budget's window after `command`: its wake added, older ones dropped. */
  const withWake = (watches: ThreadCommandWatches, command: ThreadCommandWatchUpdateCommand) => {
    const recent = recentCommandWatchWakes(watches, command.createdAt);
    return command.wake === undefined ? recent : [...recent, command.createdAt];
  };

  const afterUpdate = (
    thread: Thread,
    command: ThreadCommandWatchUpdateCommand,
  ): ThreadCommandWatches => {
    const watches = commandWatchesOf(thread);
    const next = command.next;
    if (next === null) {
      return {
        ...endCommandWatches(watches, {
          watchIds: new Set([command.watchId]),
          // The blocker requires a reason for an end.
          reason: command.endReason ?? "unwatched",
          endedAt: command.createdAt,
        }),
        // A closing message is a wake too.
        recentWakes: withWake(watches, command),
      };
    }
    const index = watches.active.findIndex((watch) => watch.watchId === next.watchId);
    return {
      active:
        index === -1
          ? [...watches.active, next]
          : watches.active.map((watch, at) => (at === index ? next : watch)),
      ended: watches.ended,
      recentWakes: withWake(watches, command),
    };
  };

  /**
   * A lifecycle command's or a stop's end of the thread's active watches (`watchId` only, when
   * given) as an event payload; null when none of them is active.
   */
  const endedPayload = (
    thread: Thread,
    reason: CommandWatchEndReason,
    occurredAt: string,
    watchId?: string,
  ): ThreadCommandWatchUpdatedPayload | null => {
    const watches = commandWatchesOf(thread);
    const ending = watches.active.filter(
      (watch) => watchId === undefined || watch.watchId === watchId,
    );
    if (ending.length === 0) return null;
    return {
      threadId: thread.id,
      watches: endCommandWatches(watches, {
        watchIds: new Set(ending.map((watch) => watch.watchId)),
        reason,
        endedAt: occurredAt,
      }),
      changed: ending.map((watch) => ({ watchId: watch.watchId, ended: reason })),
      updatedAt: occurredAt,
    };
  };

  /**
   * A `thread.command-watch.update` (the service's change) or `thread.command-watch.stop` (the
   * user's): a refusal, or the watch event's payload (null: a stop that ends nothing, accepted).
   */
  const decide = (
    readModel: OrchestrationReadModel,
    thread: Thread,
    command: ThreadCommandWatchUpdateCommand | ThreadCommandWatchStopCommand,
  ):
    | { readonly refused: string }
    | { readonly payload: ThreadCommandWatchUpdatedPayload | null } => {
    if (command.type === "thread.command-watch.stop") {
      return { payload: endedPayload(thread, "unwatched", command.createdAt, command.watchId) };
    }
    const refused = updateBlocker(readModel, thread, command);
    if (refused !== null) return { refused };
    return {
      payload: {
        threadId: thread.id,
        watches: afterUpdate(thread, command),
        changed: [
          {
            watchId: command.watchId,
            ended: command.next === null ? (command.endReason ?? null) : null,
          },
        ],
        updatedAt: command.createdAt,
      },
    };
  };

  return { decide, endedPayload };
}

export type CommandWatchRules = ReturnType<typeof makeCommandWatchRules>;
