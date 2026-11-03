import { createSharedClock, type SharedClock } from "@ryco/shared/sharedClock";

interface VisibleTickerWindow {
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(id: unknown): void;
}

interface VisibleTickerDocument {
  visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface VisibleTickerOptions {
  intervalMs: number;
  windowTarget?: VisibleTickerWindow | null | undefined;
  documentTarget?: VisibleTickerDocument | null | undefined;
  now?: (() => number) | undefined;
}

/** The shared clock (`@ryco/shared/sharedClock`), paused while the page is hidden. */
export type VisibleTicker = SharedClock;

function getDefaultWindowTarget(): VisibleTickerWindow | null {
  return typeof window === "undefined" ? null : window;
}

function getDefaultDocumentTarget(): VisibleTickerDocument | null {
  return typeof document === "undefined" ? null : document;
}

export function createVisibleTicker({
  intervalMs,
  windowTarget = getDefaultWindowTarget(),
  documentTarget = getDefaultDocumentTarget(),
  now,
}: VisibleTickerOptions): VisibleTicker {
  return createSharedClock({
    intervalMs,
    // Unset, the clock reads `Date.now()` at each tick (so a test's fake clock applies).
    ...(now ? { now } : {}),
    // Without a window (SSR, tests) nothing ticks: the timer stays unset.
    setInterval: (tick, delayMs) => windowTarget?.setInterval(tick, delayMs) ?? null,
    clearInterval: (id) => windowTarget?.clearInterval(id),
    visibility: documentTarget
      ? {
          isVisible: () => documentTarget.visibilityState !== "hidden",
          subscribe: (onChange) => {
            documentTarget.addEventListener("visibilitychange", onChange);
            return () => documentTarget.removeEventListener("visibilitychange", onChange);
          },
        }
      : null,
  });
}

/** Web's once-a-second clock for every elapsed-time label. */
export const visibleSecondTicker = createVisibleTicker({ intervalMs: 1000 });
