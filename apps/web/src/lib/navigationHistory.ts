import type { RouterHistory } from "@tanstack/react-router";

export type NavigationHistoryDirection = "back" | "forward";

/**
 * Moves one page back or forward through the router history. Back stops at
 * the first page the app opened, so it never leaves Ryco. Forward goes where
 * the browser's own Forward would, and does nothing without a later page.
 */
export function stepNavigationHistory(
  history: RouterHistory,
  direction: NavigationHistoryDirection,
): void {
  // Router pushes reach the browser a microtask later; flushing first makes
  // the step start from the page on screen.
  history.flush();
  if (direction === "forward") {
    history.forward();
  } else if (history.canGoBack()) {
    history.back();
  }
}
