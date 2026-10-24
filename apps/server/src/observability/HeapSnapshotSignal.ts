/**
 * `kill -USR2 <server pid>` writes a heap snapshot into the logs directory.
 *
 * Only the signal handler is installed at boot. The writer (`HeapSnapshot.ts`) loads with the
 * first signal: most servers never take a snapshot, so it stays off the boot path. Its phase still
 * reaches the stall monitors, which read the same phase registry (`startupStallMonitor.ts`).
 *
 * Windows has no SIGUSR2; the handler is not installed there.
 *
 * @module HeapSnapshotSignal
 */
import { Effect, Layer, type Scope } from "effect";

import { ServerConfig } from "../config.ts";
import type { HeapSnapshotDeps, HeapSnapshotTaker } from "./HeapSnapshot.ts";

export const HEAP_SNAPSHOT_SIGNAL = "SIGUSR2";

export interface HeapSnapshotSignalOptions {
  readonly platform: NodeJS.Platform;
  readonly logsDir: string;
  readonly signal?: NodeJS.Signals;
  /** Replaces some of the writer's process dependencies (tests). */
  readonly deps?: Partial<HeapSnapshotDeps>;
}

/**
 * Installs the handler for the life of the enclosing scope. Installing it also keeps the signal
 * from terminating the process (its default action).
 */
export const installHeapSnapshotSignalHandler = (
  options: HeapSnapshotSignalOptions,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    if (options.platform === "win32") return;
    const signal = options.signal ?? HEAP_SNAPSHOT_SIGNAL;
    // One writer per handler: its in-progress guard and cooldown also cover signals that arrive
    // while its module is still loading.
    let taker: HeapSnapshotTaker | null = null;
    const take = Effect.tryPromise({
      try: () => import("./HeapSnapshot.ts"),
      catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
    }).pipe(
      Effect.flatMap(({ makeDefaultHeapSnapshotDeps, makeHeapSnapshotTaker }) => {
        taker ??= makeHeapSnapshotTaker({
          ...makeDefaultHeapSnapshotDeps(options.logsDir),
          ...options.deps,
        });
        return taker.take;
      }),
      Effect.catch((cause) =>
        Effect.logWarning("Heap snapshot failed: could not load the snapshot writer", { cause }),
      ),
    );
    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const handler = () => {
          runFork(take);
        };
        process.on(signal, handler);
        return handler;
      }),
      (handler) => Effect.sync(() => process.off(signal, handler)),
    );
  });

/** Only the server layer provides this; CLI subcommands never register the handler. */
export const HeapSnapshotLive: Layer.Layer<never, never, ServerConfig> = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    yield* installHeapSnapshotSignalHandler({
      platform: process.platform,
      logsDir: config.logsDir,
    });
  }),
);
