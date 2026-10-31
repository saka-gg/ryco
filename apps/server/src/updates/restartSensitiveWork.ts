/**
 * RestartSensitiveWork - work a restart of this server would cut off and leave half done.
 *
 * Repository clones, worktree checkouts (creating, fetching their base, removing them) and storage
 * cleanup count themselves here while they run, however they end. An unattended restart (a CLI
 * node updating itself, `nodeAutoUpdater.ts`) waits until nothing is counted
 * (`updateWindow.ts`); terminals and agent work have their own checks there.
 *
 * One counter serves the process: a Reference's default is made once, so every service reads and
 * writes the same one without layer wiring. Tests provide their own.
 *
 * Port of T3 Code's unmerged `RestartWork` (pingdotgg/t3code#17586).
 *
 * @module RestartSensitiveWork
 */
import { Context, Effect } from "effect";

export interface RestartSensitiveWorkShape {
  /** Counts `effect` from now until it ends, however it ends. */
  readonly track: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** How much counted work runs now. */
  readonly count: Effect.Effect<number>;
}

export function makeRestartSensitiveWork(): RestartSensitiveWorkShape {
  let active = 0;
  return {
    track: (effect) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          active += 1;
        }),
        () => effect,
        () =>
          Effect.sync(() => {
            active -= 1;
          }),
      ),
    count: Effect.sync(() => active),
  };
}

export const RestartSensitiveWork = Context.Reference<RestartSensitiveWorkShape>(
  "ryco/updates/RestartSensitiveWork",
  { defaultValue: makeRestartSensitiveWork },
);
