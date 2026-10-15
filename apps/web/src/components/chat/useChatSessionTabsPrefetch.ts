import { useEffect, useMemo } from "react";
import { parseScopedThreadKey } from "@ryco/client-runtime/scoped";
import { retainThreadDetailSubscription } from "../../environments/runtime/service";
import { startStaggeredThreadPrefetch } from "../../lib/staggeredThreadPrefetch";
import { markTabSwitchFirstPaint } from "../../perf/tabSwitchInstrumentation";
import type { SessionTabItem } from "../../sessionTabs.selectors";

export interface UseChatSessionTabsPrefetchInput {
  activeWorktreeSessionTabs: ReadonlyArray<SessionTabItem>;
  activeSessionTabKey: string | null;
  /**
   * Whether the active thread's own live window has been applied (always true
   * for drafts); messages hydrated from a read cache do not count. Sibling
   * windows wait for it, so they never queue ahead of or compete with the
   * thread being opened.
   */
  activeDetailLoaded: boolean;
}

export const MAX_SPECULATIVE_SIBLING_TAB_PREFETCH = 6;

export function selectSpeculativeSiblingTabPrefetchKeys(
  activeWorktreeSessionTabs: ReadonlyArray<SessionTabItem>,
  activeSessionTabKey: string | null,
  limit = MAX_SPECULATIVE_SIBLING_TAB_PREFETCH,
): ReadonlyArray<string> {
  if (limit <= 0 || activeWorktreeSessionTabs.length === 0) {
    return [];
  }

  const cappedLimit = Math.floor(limit);
  const activeIndex =
    activeSessionTabKey === null
      ? -1
      : activeWorktreeSessionTabs.findIndex((tab) => tab.key === activeSessionTabKey);
  if (activeIndex < 0) {
    return activeWorktreeSessionTabs
      .map((tab) => tab.key)
      .filter((key) => key !== activeSessionTabKey)
      .slice(0, cappedLimit);
  }

  const keys: string[] = [];
  for (let offset = 1; keys.length < cappedLimit; offset += 1) {
    const left = activeWorktreeSessionTabs[activeIndex - offset];
    const right = activeWorktreeSessionTabs[activeIndex + offset];
    if (!left && !right) {
      break;
    }
    if (left) {
      keys.push(left.key);
      if (keys.length >= cappedLimit) {
        break;
      }
    }
    if (right) {
      keys.push(right.key);
    }
  }

  return keys;
}

/**
 * Speculatively warms WS subscriptions for nearby sibling sessions in the
 * active worktree and records the first-paint perf mark when the active
 * session changes.
 */
export function useChatSessionTabsPrefetch(input: UseChatSessionTabsPrefetchInput): void {
  const { activeWorktreeSessionTabs, activeSessionTabKey, activeDetailLoaded } = input;

  // Speculatively warm WS subscriptions for nearby sibling sessions in the
  // active worktree, so switching to a sibling lands on warm data.
  // Subscriptions are reference-counted by retainThreadDetailSubscription and
  // idle ones are evicted by the existing cap. They start only once the
  // active thread's own window is in, in idle time and one at a time: up to
  // six windows (80-500 KB each) arriving with the active one would delay it.
  const prefetchSignature = useMemo(
    () =>
      selectSpeculativeSiblingTabPrefetchKeys(activeWorktreeSessionTabs, activeSessionTabKey).join(
        "\n",
      ),
    [activeWorktreeSessionTabs, activeSessionTabKey],
  );
  useEffect(() => {
    if (!activeDetailLoaded || prefetchSignature.length === 0) return;
    return startStaggeredThreadPrefetch(prefetchSignature.split("\n"), (key) => {
      const ref = parseScopedThreadKey(key);
      return ref ? retainThreadDetailSubscription(ref.environmentId, ref.threadId) : null;
    });
  }, [activeDetailLoaded, prefetchSignature]);

  useEffect(() => {
    if (!activeSessionTabKey) return;
    const key = activeSessionTabKey;
    queueMicrotask(() => markTabSwitchFirstPaint(key));
  }, [activeSessionTabKey]);
}
