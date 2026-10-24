import fsPromises from "node:fs/promises";
import os from "node:os";

import { Effect, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";

/** Blocks the event loop for `ms`, as a long synchronous task or a GC pause does. */
export const blockEventLoop = (ms: number): void => {
  const end = performance.now() + ms;
  let spins = 0;
  while (performance.now() < end) spins += 1;
  void spins;
};

/**
 * Blocks the loop for `ms` in the next timers phase, after everything started
 * now (including fibers scheduled with setImmediate) has registered its timers.
 */
export const stallEventLoopSoon = (ms: number): Effect.Effect<void> =>
  Effect.sync(() => {
    setTimeout(() => blockEventLoop(ms), 0);
  });

/**
 * Work that waits on a timer and then on real I/O. After a stall it can only
 * finish once the loop polls again, which is after every expired timer fired.
 */
export const timerThenIo = (ms: number): Effect.Effect<void> =>
  Effect.sleep(ms).pipe(
    Effect.andThen(Effect.promise(() => fsPromises.stat(os.tmpdir()))),
    Effect.asVoid,
  );

const encoder = new TextEncoder();

/**
 * A spawner whose child prints "out" and exits 0 after `exitAfterMs` plus an
 * I/O round trip, while the event loop is blocked for `stallMs` right after
 * the spawn: the child is done during the stall, but its exit is read later.
 */
export const stallingChildSpawner = (options: {
  readonly exitAfterMs: number;
  readonly stallMs: number;
}) => {
  const kills = { count: 0 };
  let running = true;
  const spawner = ChildProcessSpawner.make(() =>
    stallEventLoopSoon(options.stallMs).pipe(
      Effect.as(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: timerThenIo(options.exitAfterMs).pipe(
            Effect.map(() => {
              running = false;
              return ChildProcessSpawner.ExitCode(0);
            }),
          ),
          isRunning: Effect.sync(() => running),
          kill: () =>
            Effect.sync(() => {
              kills.count += 1;
              running = false;
            }),
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(encoder.encode("out")),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ),
    ),
  );
  return { kills, spawner };
};
