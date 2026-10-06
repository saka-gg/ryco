import type { LifecycleSuggestions } from "@ryco/contracts";

/**
 * Pinned threads are never suggested for archiving. A pinned thread also keeps its
 * workspace's checkout out of removal suggestions, mirroring the server's exclusion
 * of threads with live terminals (pinning is client-side, so the client applies it).
 */
export function excludePinnedSuggestions(
  suggestions: LifecycleSuggestions,
  isPinned: (threadId: string) => boolean,
  pinnedWorktreeIds: ReadonlySet<string> = new Set(),
): LifecycleSuggestions {
  return {
    ...suggestions,
    threads: suggestions.threads.filter((thread) => !isPinned(thread.threadId)),
    checkouts: suggestions.checkouts.filter(
      (checkout) => !pinnedWorktreeIds.has(checkout.worktreeId),
    ),
  };
}
