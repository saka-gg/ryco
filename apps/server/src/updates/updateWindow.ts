/**
 * updateWindow - when an unattended update may replace something without anyone noticing.
 *
 * Loaded with unattended updates (`unattendedUpdates.ts`), never on boot. The window is open only
 * while all of these hold, and any read that fails closes it:
 *
 * 1. Nobody used a client of this node for {@link QUIET_PERIOD} (`ClientInteraction`, monotonic,
 *    so time asleep never counts as quiet).
 * 2. Nothing an update would interrupt runs: no agent works or stopped working less than 2 minutes
 *    ago, no session is starting, no thread waits on an approval or a question
 *    (`AgentWorkActivity.interruptible`).
 * 3. No Ryco on this machine runs a provider installer (the host-wide install lock), the one lock
 *    the caller holds itself aside.
 * 4. No other Ryco process on this machine has agents working (its busy marker beside the lock):
 *    provider CLIs are the machine's, so another node's turn would lose its CLI too.
 *
 * Restart mode (`restart: true`, before an update that restarts this server) also needs, since a
 * restart cuts off everyone at once:
 *
 * 5. {@link RESTART_QUIET_PERIOD} without client input instead of {@link QUIET_PERIOD}.
 * 6. Nothing the next start would offer to continue (`AgentWorkActivity.restartInterruptible`),
 *    no terminal running a command or starting, and no restart-sensitive work (clones, worktree
 *    checkouts, storage cleanup: `RestartSensitiveWork`).
 *
 * Port of T3 Code's unmerged `UpdateWindow` (pingdotgg/t3code#17585, restart mode #17586).
 *
 * @module updateWindow
 */
import { Cause, Duration, Effect, Option } from "effect";

import type { AgentWorkActivityShape } from "../orchestration/AgentWorkActivity.ts";
import type { ProviderInstallLockShape } from "../provider/Services/ProviderInstallLock.ts";
import type { ClientInteractionShape } from "./ClientInteraction.ts";
import type { RestartSensitiveWorkShape } from "./restartSensitiveWork.ts";

/** How long every client must be untouched before an update may run. */
export const QUIET_PERIOD = Duration.minutes(2);
/** A restart disconnects every client, so it waits longer than an install. */
export const RESTART_QUIET_PERIOD = Duration.minutes(5);

export interface UpdateWindowSources {
  readonly agentWork: Pick<AgentWorkActivityShape, "interruptible" | "restartInterruptible">;
  readonly clientInteraction: Pick<ClientInteractionShape, "sinceLast">;
  readonly installLock: Pick<ProviderInstallLockShape, "lock">;
  /** Whether a terminal runs a command or is starting (`isTerminalWorking`); restart mode only. */
  readonly busyTerminals: Effect.Effect<boolean>;
  /** Clones, worktree checkouts and storage cleanup running now; restart mode only. */
  readonly restartSensitiveWork: Pick<RestartSensitiveWorkShape, "count">;
}

export interface UpdateWindowOptions {
  /** The install lock the caller holds, which would otherwise close the window on itself. */
  readonly heldLockKey?: string;
  /** The caller will restart this server: everything it would cut off must have stopped. */
  readonly restart?: boolean;
}

export interface UpdateWindow {
  /** Whether the window is open now; closed when anything cannot be read. */
  readonly isOpen: (options?: UpdateWindowOptions) => Effect.Effect<boolean>;
  /** Runs `effect` while the window is open, otherwise returns `None` without running it. */
  readonly runIfOpen: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    options?: UpdateWindowOptions,
  ) => Effect.Effect<Option.Option<A>, E, R>;
}

export function makeUpdateWindow(sources: UpdateWindowSources): UpdateWindow {
  const isOpen = (options?: UpdateWindowOptions): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const restart = options?.restart === true;
      // Cheapest first: a timestamp, the in-memory model and counter, then the terminals'
      // diagnostics and two readdirs.
      const quietPeriod = restart ? RESTART_QUIET_PERIOD : QUIET_PERIOD;
      if (Duration.isLessThan(yield* sources.clientInteraction.sinceLast, quietPeriod)) {
        return false;
      }
      if (yield* sources.agentWork.interruptible) return false;
      if (restart) {
        if (yield* sources.agentWork.restartInterruptible) return false;
        if ((yield* sources.restartSensitiveWork.count) > 0) return false;
        if (yield* sources.busyTerminals) return false;
      }
      // Covers one-click updates and installs other Ryco processes on this machine run.
      const lock = yield* sources.installLock.lock;
      const held =
        options?.heldLockKey === undefined ? lock.anyHeld : lock.anyHeldExcept(options.heldLockKey);
      if (yield* held) return false;
      return !(yield* lock.othersBusy);
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("Update window could not be read; treating it as closed", {
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(false)),
      ),
    );

  return {
    isOpen,
    runIfOpen: (effect, options) =>
      Effect.flatMap(isOpen(options), (open) =>
        open ? Effect.asSome(effect) : Effect.succeedNone,
      ),
  };
}
