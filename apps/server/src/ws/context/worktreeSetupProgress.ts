import type { ThreadId } from "@ryco/contracts";
import { Deferred, Effect } from "effect";

import type { WorktreeSetupHandle } from "../../project/Services/WorktreeSetupTracker.ts";
import type { TerminalManagerShape } from "../../terminal/Services/Manager.ts";
import type { GitWorktreeCreationProgress } from "../../vcs/GitVcsDriver.ts";

// Git redraws its checkout meter every few milliseconds; a feed this dense
// would only restart the client's progress bar before it moves.
const CHECKOUT_PROGRESS_INTERVAL_MS = 80;

/** Maps `createWorktree`'s fetch and checkout callbacks onto the setup's stages. */
export function worktreeCreationProgress(handle: WorktreeSetupHandle): GitWorktreeCreationProgress {
  let lastCheckoutProgressAtMs = 0;
  return {
    onFetchStarted: () => handle.stage("fetch", { status: "running" }),
    onFetchFinished: ({ reused, branch }) =>
      handle
        .setCheckout({ baseRef: `origin/${branch}` })
        .pipe(
          Effect.andThen(
            handle.stage("fetch", { status: "done", ...(reused ? { detail: "prefetched" } : {}) }),
          ),
        ),
    onCheckoutStarted: () => handle.stage("checkout", { status: "running", percent: 0 }),
    onCheckoutProgress: (percent) => {
      const nowMs = Date.now();
      if (percent < 100 && nowMs - lastCheckoutProgressAtMs < CHECKOUT_PROGRESS_INTERVAL_MS) {
        return Effect.void;
      }
      lastCheckoutProgressAtMs = nowMs;
      return handle.stage("checkout", { percent });
    },
  };
}

// The terminal reports subprocess activity from a process-table poll that runs
// about every second after input (the script's launch) and once output goes
// quiet, so a script that ends sooner may never show as running. Quiet output
// that long after launch counts as finished.
const QUICK_SCRIPT_GRACE_MS = 2_500;
const QUICK_SCRIPT_QUIET_MS = 1_500;
// Past this the feed stops following the script; the terminal keeps running it.
const MAX_WATCH_MS = 30 * 60_000;
const WATCH_TICK_MS = 500;

/**
 * Follows the setup script's terminal after the turn started: its output feeds
 * the snapshot's tail, and the stage settles once the script's process is
 * gone. Runs detached from the request that launched it.
 */
export const watchSetupScriptTerminal = (input: {
  readonly handle: WorktreeSetupHandle;
  readonly terminalManager: Pick<TerminalManagerShape, "subscribe">;
  readonly threadId: ThreadId;
  readonly terminalId: string;
}) =>
  Effect.gen(function* () {
    const { handle } = input;
    const startedAtMs = Date.now();
    let lastOutputAtMs = startedAtMs;
    let sawRunning = false;
    const ended = yield* Deferred.make<void>();
    const end = Deferred.succeed(ended, undefined).pipe(Effect.asVoid);

    const unsubscribe = yield* input.terminalManager.subscribe((event) => {
      if (event.threadId !== input.threadId || event.terminalId !== input.terminalId) {
        return Effect.void;
      }
      switch (event.type) {
        case "output":
          lastOutputAtMs = Date.now();
          return handle.appendOutput(event.data);
        case "activity":
          if (event.hasRunningSubprocess) {
            sawRunning = true;
            return Effect.void;
          }
          return sawRunning ? end : Effect.void;
        case "exited":
        case "error":
          return end;
        default:
          return Effect.void;
      }
    });

    const watchdog = Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(WATCH_TICK_MS);
        const nowMs = Date.now();
        if (nowMs - startedAtMs > MAX_WATCH_MS) return;
        if (
          !sawRunning &&
          nowMs - startedAtMs > QUICK_SCRIPT_GRACE_MS &&
          nowMs - lastOutputAtMs > QUICK_SCRIPT_QUIET_MS
        ) {
          return;
        }
      }
    });

    yield* Effect.raceFirst(Deferred.await(ended), watchdog).pipe(
      Effect.ensuring(Effect.sync(unsubscribe)),
    );
    yield* handle.stage("setup-script", { status: "done" });
  }).pipe(Effect.ensuring(input.handle.release), Effect.forkDetach, Effect.asVoid);
