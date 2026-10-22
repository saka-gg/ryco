/**
 * ProjectCopyProcess - what the long-running steps of a cross-node copy share about the child
 * processes they run (git clone and fetch, submodules, LFS, the setup command).
 *
 * Every such step is cancelled by interrupting its effect: the child's process group gets
 * SIGTERM, then SIGKILL after 5 s (`forceKillAfter`), and the effect completes only once the
 * child exited, so cleanup never races a process that is still writing.
 *
 * @module ProjectCopyProcess
 */
import type { Effect } from "effect";

/** A child process a step spawned, recorded so a later process can find it after a crash. */
export interface ProjectCopyChildProcess {
  readonly pid: number;
  /** Its process group; children are spawned detached, as their own group leader. Null on Windows. */
  readonly pgid: number | null;
  /**
   * When it started (ISO), read right after the spawn. Startup recovery compares it with the
   * OS's start time for `pid` and signals the group only when they match, so a reused pid is
   * never signalled.
   */
  readonly startedAt: string;
}

/** What a step reports while its child runs. Callbacks must be cheap and never fail. */
export interface ProjectCopyProcessObserver {
  /** The child it spawned (to persist), then null once that child exited. */
  readonly onChild?: ((child: ProjectCopyChildProcess | null) => Effect.Effect<void>) | undefined;
  /** Output text in arrival order (git's stderr, or both streams of the setup), for the tail. */
  readonly onOutput?: ((chunk: string) => Effect.Effect<void>) | undefined;
}
