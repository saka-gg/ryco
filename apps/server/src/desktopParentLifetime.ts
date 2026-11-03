/**
 * desktopParentLifetime - Shuts a desktop backend down when its app is gone.
 *
 * A desktop-launched backend shares an inherited duplex pipe (fd 4) with its
 * Electron app (see `DesktopResourceTelemetry`). The app keeps its end open
 * for as long as it runs and never closes it while it wants the backend:
 * quitting, updating and restarting stop the backend first and wait for its
 * exit. Only the app holds that end (libuv creates it close-on-exec), so it
 * closes exactly when the app exits or crashes, whatever children either
 * process started. The backend keeps its end open too. When the pipe ends,
 * fails or closes, nobody is left to stop the backend, which would keep its
 * port, its provider children and its database. It shuts down the way SIGTERM
 * does instead: the main program is interrupted, so the usual scoped
 * finalizers run (restart hints, provider stops, SQLite close), and an unref'd
 * watchdog ends the process if they hang. The app also holds the backend's
 * stdout and stderr, whose writes fail once it is gone; those errors are
 * ignored, so they cannot cut the shutdown short.
 *
 * @module desktopParentLifetime
 */
import type { Duplex } from "node:stream";

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * How long shutdown may run once the app is gone before the process exits
 * anyway. The app's own SIGTERM-to-SIGKILL fallback left with it.
 */
export const DESKTOP_PARENT_LOSS_SHUTDOWN_TIMEOUT_MS = 20_000;

/** Completed once the app is gone; `null` while no desktop pipe is watched. */
let appGone: Deferred.Deferred<void> | null = null;
let shutdownWatchdog: ReturnType<typeof setTimeout> | undefined;
const ignoreStdioWriteError = () => {};

export interface DesktopParentPipeWatchOptions {
  /** Overrides {@link DESKTOP_PARENT_LOSS_SHUTDOWN_TIMEOUT_MS}. */
  readonly shutdownTimeoutMs?: number;
}

/**
 * Takes the end, failure or close of the desktop pipe for the app's exit. The
 * backend closes the pipe only once it has failed (its telemetry reader drops
 * malformed input instead), so any close means the app is gone. The watchdog
 * is armed right then, so a backend stuck before or outside
 * {@link withDesktopParentLifetime} still ends. Its end is only seen while the
 * pipe is read (the telemetry reader does). Only the first pipe of a process
 * is watched; start it before {@link withDesktopParentLifetime} runs.
 */
export function watchDesktopParentPipe(
  pipe: Duplex,
  options: DesktopParentPipeWatchOptions = {},
): void {
  // Bun (the development backend) cannot adopt an inherited descriptor as a
  // socket: it never reads, and its first write fails with ERR_SOCKET_CLOSED,
  // so there the pipe's close says nothing about the app.
  if (appGone !== null || typeof Bun !== "undefined") return;
  const gone = Deferred.makeUnsafe<void>();
  appGone = gone;
  // Once the app is gone, writing to the stdout and stderr pipes it held fails
  // with EPIPE, which Node raises as an uncaught error, from console.log too,
  // killing the backend mid-shutdown with its finalizers skipped. The app reads
  // both for as long as it runs, and the server log file keeps every line.
  process.stdout.on("error", ignoreStdioWriteError);
  process.stderr.on("error", ignoreStdioWriteError);
  const onPipeGone = () => {
    if (Deferred.isDoneUnsafe(gone)) return;
    Deferred.doneUnsafe(gone, Effect.void);
    const timeoutMs = options.shutdownTimeoutMs ?? DESKTOP_PARENT_LOSS_SHUTDOWN_TIMEOUT_MS;
    shutdownWatchdog = setTimeout(() => {
      try {
        process.stderr.write(
          `Desktop app is gone and backend shutdown did not finish within ${timeoutMs} ms; exiting.\n`,
        );
      } finally {
        process.exit(1);
      }
    }, timeoutMs);
    shutdownWatchdog.unref();
  };
  pipe.on("end", onPipeGone);
  pipe.on("error", onPipeGone);
  pipe.on("close", onPipeGone);
}

export function resetDesktopParentLifetimeForTests(): void {
  appGone = null;
  clearTimeout(shutdownWatchdog);
  shutdownWatchdog = undefined;
  process.stdout.off("error", ignoreStdioWriteError);
  process.stderr.off("error", ignoreStdioWriteError);
}

/**
 * Runs `program` until it ends or the desktop app is gone. The app's loss
 * interrupts `program`, so its scoped finalizers run as on SIGTERM, and the
 * result is an interruption, so the process exits as on SIGTERM (code 130).
 * While no desktop pipe is watched this is `program` itself.
 */
export const withDesktopParentLifetime = <A, E, R>(
  program: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    const gone = appGone;
    if (gone === null) return program;
    return Effect.raceFirst(program, Deferred.await(gone).pipe(Effect.andThen(Effect.interrupt)));
  });

/**
 * Names the app's loss as the reason when it is what shuts the server down.
 * {@link withDesktopParentLifetime} runs outside the server's loggers, so this
 * finalizer logs from inside them, where the line reaches the server log; build
 * it last so it runs first.
 */
export const DesktopParentLossShutdownLogLive = Layer.effectDiscard(
  Effect.addFinalizer(() =>
    Effect.suspend(() =>
      appGone !== null && Deferred.isDoneUnsafe(appGone)
        ? Effect.logWarning("desktop app is gone; shutting the backend down")
        : Effect.void,
    ),
  ),
);
