import { useLayoutEffect, type RefObject } from "react";

import type { PullRequestsTab } from "./pullRequestsSearch";

/**
 * Keyboard focus across reader remounts. The reader is keyed by pull request,
 * so J/K, `[`/`]`, a stack row or Enter in the full-page list replace the
 * subtree that held focus. A region that unmounts while it holds focus hands
 * it off; the reader mounting in the same commit takes it and focuses its
 * active tab, so the next Tab continues in the reader instead of at <body>.
 * The handoff expires at the end of the task, so a later, unrelated mount
 * never steals focus.
 */
let handoffPending = false;

export function handOffPageFocus(): void {
  handoffPending = true;
  queueMicrotask(() => {
    handoffPending = false;
  });
}

export function takePageFocusHandoff(): boolean {
  const pending = handoffPending;
  handoffPending = false;
  return pending;
}

/** Hands focus off when `ref`'s element unmounts while it (or a descendant) is focused. */
export function useHandOffFocusOnUnmount(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const element = ref.current;
    return () => {
      // Layout cleanups of a removed subtree run while it is still attached.
      if (element && element.contains(document.activeElement)) handOffPageFocus();
    };
  }, [ref]);
}

export const READER_TAB_SELECTOR_ATTRIBUTE = "data-pr-reader-tab";

/** The reader bar's button for `tab`, inside `root` (default: the document). */
export function readerTabButton(
  tab: PullRequestsTab | null,
  root: ParentNode = document,
): HTMLElement | null {
  const selector =
    tab === null
      ? `[${READER_TAB_SELECTOR_ATTRIBUTE}] [role="tab"][aria-selected="true"]`
      : `[${READER_TAB_SELECTOR_ATTRIBUTE}] [role="tab"][data-sliding-tab-id="${tab}"]`;
  return root.querySelector<HTMLElement>(selector);
}
