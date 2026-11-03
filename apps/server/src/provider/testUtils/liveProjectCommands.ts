/**
 * Polls an adapter's `readLiveProjectCommands` until a pushed list arrives. Agents push their
 * commands as session notifications, which the adapter handles after the request that caused
 * them has answered. Sleeps on the real clock, so it works under `it.effect`'s TestClock.
 *
 * @module provider/testUtils/liveProjectCommands
 */
import type { ProviderProjectCommands } from "@ryco/contracts";
import { Effect } from "effect";

export const waitForLiveProjectCommands = (
  adapter: {
    readonly readLiveProjectCommands: (
      cwd: string,
    ) => Effect.Effect<ProviderProjectCommands | undefined>;
  },
  cwd: string,
  ready: (commands: ProviderProjectCommands | undefined) => boolean = (commands) =>
    commands !== undefined,
): Effect.Effect<ProviderProjectCommands | undefined> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const commands = yield* adapter.readLiveProjectCommands(cwd);
      if (ready(commands)) return commands;
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
    }
    return yield* Effect.die(new Error(`No matching live commands for ${cwd}.`));
  });
