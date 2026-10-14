/**
 * WorktreeSetupTracker - Live progress of the worktree a first send prepares.
 *
 * `thread.turn.start` with a worktree bootstrap fetches the base, checks the
 * worktree out, launches the project's setup script and starts the turn, all
 * inside one command. This feed lets the sending client show those stages as
 * they happen instead of a generic "working" state. It is presentation data
 * held in memory: a node restart loses it, and nothing depends on it for
 * correctness.
 *
 * @module WorktreeSetupTracker
 */
import type {
  ThreadId,
  WorktreeSetupSnapshot,
  WorktreeSetupStageId,
  WorktreeSetupStageStatus,
} from "@ryco/contracts";
import { Context } from "effect";
import type { Effect, Stream } from "effect";

export interface WorktreeSetupStagePatch {
  readonly status?: WorktreeSetupStageStatus;
  readonly percent?: number;
  readonly detail?: string;
}

/** One setup's writer, held by the bootstrap that runs it. */
export interface WorktreeSetupHandle {
  readonly stage: (id: WorktreeSetupStageId, patch: WorktreeSetupStagePatch) => Effect.Effect<void>;
  readonly setCheckout: (input: {
    /** The base as fetched (`origin/HEAD` resolved to its branch). */
    readonly baseRef?: string;
    readonly branch?: string;
    readonly worktreePath?: string;
    readonly setupTerminalId?: string;
  }) => Effect.Effect<void>;
  /** Feeds raw setup-script terminal output into the snapshot's tail. */
  readonly appendOutput: (chunk: string) => Effect.Effect<void>;
  /**
   * Ends the setup. `done` once the turn was dispatched; a still-running setup
   * script keeps its stage and the output tail live afterwards.
   */
  readonly finish: (status: "done" | "failed" | "cancelled", error?: string) => Effect.Effect<void>;
  /** Whether the user asked to stop this setup. */
  readonly cancelRequested: Effect.Effect<boolean>;
  /**
   * Past this point a cancel request is refused (the turn is being started).
   * False when a cancel already arrived.
   */
  readonly markUncancellable: Effect.Effect<boolean>;
  /** Releases the snapshot once nothing still writes to it. */
  readonly release: Effect.Effect<void>;
}

export interface WorktreeSetupTrackerShape {
  /** Starts tracking a setup, replacing any earlier one of the same thread. */
  readonly begin: (input: {
    readonly threadId: ThreadId;
    readonly baseRef: string;
    readonly branch?: string;
    readonly fetchOrigin: boolean;
  }) => Effect.Effect<WorktreeSetupHandle>;
  /**
   * The thread's setup snapshots: the current one (if any), then every change.
   * A subscriber may arrive before the setup begins; it then waits for it.
   */
  readonly stream: (threadId: ThreadId) => Stream.Stream<WorktreeSetupSnapshot>;
  /** Asks a running setup to stop; false when nothing cancellable runs. */
  readonly cancel: (threadId: ThreadId) => Effect.Effect<boolean>;
}

export class WorktreeSetupTracker extends Context.Service<
  WorktreeSetupTracker,
  WorktreeSetupTrackerShape
>()("ryco/project/WorktreeSetupTracker") {}
