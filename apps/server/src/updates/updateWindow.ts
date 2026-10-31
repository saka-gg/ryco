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
 * 3. No Ryco on this machine runs a provider installer (the host-wide install lock), unless the
 *    caller holds that lock itself.
 *
 * Port of T3 Code's unmerged `UpdateWindow` (pingdotgg/t3code#17585).
 *
 * @module updateWindow
 */
import { Cause, Duration, Effect, Option } from "effect";

import type { AgentWorkActivityShape } from "../orchestration/AgentWorkActivity.ts";
import type { ProviderInstallLockShape } from "../provider/Services/ProviderInstallLock.ts";
import type { ClientInteractionShape } from "./ClientInteraction.ts";

/** How long every client must be untouched before an update may run. */
export const QUIET_PERIOD = Duration.minutes(2);

export interface UpdateWindowSources {
  readonly agentWork: Pick<AgentWorkActivityShape, "interruptible">;
  readonly clientInteraction: Pick<ClientInteractionShape, "sinceLast">;
  readonly installLock: Pick<ProviderInstallLockShape, "lock">;
}

export interface UpdateWindowOptions {
  /** The caller holds an install lock, which would otherwise close the window on itself. */
  readonly ignoreInstallLocks?: boolean;
}

export interface UpdateWindow {
  /** Whether the window is open now; closed when anything cannot be read. */
  readonly isOpen: (options?: UpdateWindowOptions) => Effect.Effect<boolean>;
  /** Runs `effect` while the window is open, otherwise returns `None` without running it. */
  readonly runIfOpen: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<Option.Option<A>, E, R>;
}

export function makeUpdateWindow(sources: UpdateWindowSources): UpdateWindow {
  const isOpen = (options?: UpdateWindowOptions): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      // Cheapest first: a timestamp, the in-memory model, then one readdir.
      if (Duration.isLessThan(yield* sources.clientInteraction.sinceLast, QUIET_PERIOD)) {
        return false;
      }
      if (yield* sources.agentWork.interruptible) return false;
      if (options?.ignoreInstallLocks === true) return true;
      // Covers one-click updates and installs other Ryco processes on this machine run.
      const lock = yield* sources.installLock.lock;
      return !(yield* lock.anyHeld);
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
    runIfOpen: (effect) =>
      Effect.flatMap(isOpen(), (open) => (open ? Effect.asSome(effect) : Effect.succeedNone)),
  };
}
