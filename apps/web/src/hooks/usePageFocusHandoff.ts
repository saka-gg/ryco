import { useLayoutEffect, type RefObject } from "react";

/**
 * Keyboard focus across page remounts. A page detail keyed by its subject
 * (the pull request, the project) is replaced by J/K and similar keys, which
 * destroys the subtree that held focus. A region that unmounts while it holds focus hands
 * it off; the detail mounting in the same commit takes it and focuses its
 * active tab, so the next Tab continues there instead of at <body>.
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
