import type { ScopedThreadRef } from "@ryco/contracts";

import { stackedThreadToast, toastManager } from "./toast";

/**
 * A code-split surface whose chunk failed to load (offline, or a deploy
 * replaced it): say so, and offer the retry. Without this the surface would
 * stay blank or closed with nothing pointing at the cause, or — mounted
 * anyway — throw to the root error view and take the whole app down.
 *
 * Pass `threadRef` when the retry reopens something bound to that thread (a
 * dialog's target, a handoff marker): the toast then shows only while that
 * thread is open, so its Retry never reopens the surface over another thread.
 */
export function notifySurfaceLoadFailure(
  surface: string,
  error: unknown,
  retry: () => void,
  threadRef?: ScopedThreadRef | null,
): void {
  console.warn(`The ${surface} failed to load.`, error);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: `Couldn't load the ${surface}`,
      description: "Check the connection, then try again.",
      actionProps: { children: "Retry", onClick: retry },
      ...(threadRef ? { data: { threadRef } } : {}),
    }),
  );
}
