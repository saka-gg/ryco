import type { EnvironmentApi, ThreadId } from "@ryco/contracts";

import { isWorktreeSetupFeedSettled } from "./logic.ts";
import { useWorktreeLaunchStore } from "./store.ts";

export type WorktreeSetupFeedApi = {
  readonly vcs: Pick<EnvironmentApi["vcs"], "onWorktreeSetup">;
};

const feedsByKey = new Map<string, () => void>();

/**
 * Follows the node's setup feed for a launch until it settles (the setup ended
 * and no setup script still runs) or {@link stopWorktreeLaunchFeed}. Opened
 * before the send's command goes out: the node holds back nothing, so a feed
 * that attaches late still starts from the current snapshot.
 */
export function startWorktreeLaunchFeed(input: {
  readonly api: WorktreeSetupFeedApi;
  readonly key: string;
  readonly threadId: ThreadId;
}): void {
  stopWorktreeLaunchFeed(input.key);
  const store = useWorktreeLaunchStore.getState();
  const subscribe = input.api.vcs.onWorktreeSetup;
  if (!subscribe) {
    store.markFeedUnavailable(input.key);
    return;
  }
  let unsubscribe: (() => void) | null = null;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (feedsByKey.get(input.key) === stop) feedsByKey.delete(input.key);
    unsubscribe?.();
  };
  feedsByKey.set(input.key, stop);
  unsubscribe = subscribe(
    { threadId: input.threadId },
    (snapshot) => {
      useWorktreeLaunchStore.getState().applySnapshot(input.key, snapshot);
      if (isWorktreeSetupFeedSettled(snapshot)) stop();
    },
    {
      onError: () => {
        useWorktreeLaunchStore.getState().markFeedUnavailable(input.key);
        stop();
      },
    },
  );
  // The callback can settle the feed synchronously, before `unsubscribe` was set.
  if (stopped) unsubscribe();
}

export function stopWorktreeLaunchFeed(key: string): void {
  feedsByKey.get(key)?.();
}
