/**
 * The boot side of the command watch rules (`commandWatchUpdates.ts`): a cached `import()` of
 * them with the boot-side helpers they use. Until a chat has a command watch, they never load.
 *
 * @module commandWatchLoader
 */
import {
  COMMAND_WATCH_WAKE_MESSAGE_PREFIX,
  COMMAND_WATCH_WAKES_PER_DAY,
  COMMAND_WATCHES_PER_NODE,
  COMMAND_WATCHES_PER_THREAD,
} from "@ryco/contracts";
import { Effect } from "effect";

import { isThreadLive, threadLifecycleTurnBlocker } from "./commandInvariants.ts";
import type { CommandWatchRules } from "./commandWatchUpdates.ts";

let loaded: Promise<CommandWatchRules> | undefined;

/** The rules, loaded once per process on first use. */
export const loadCommandWatchRules: Effect.Effect<CommandWatchRules> = Effect.promise(
  () =>
    (loaded ??= import("./commandWatchUpdates.ts").then((module) =>
      module.makeCommandWatchRules({
        isThreadLive,
        threadLifecycleTurnBlocker,
        wakeMessagePrefix: COMMAND_WATCH_WAKE_MESSAGE_PREFIX,
        perThread: COMMAND_WATCHES_PER_THREAD,
        perNode: COMMAND_WATCHES_PER_NODE,
        wakesPerDay: COMMAND_WATCH_WAKES_PER_DAY,
      }),
    )),
);
