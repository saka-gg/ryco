import { useEffect } from "react";

/** The publisher is not needed for first paint; it loads once the app is idle. */
const PUBLISHER_IDLE_TIMEOUT_MS = 5_000;

/**
 * Keeps Agent Control's node directory current on every node that supports
 * project copy while the component that calls it is mounted (the app shell).
 * The publisher module loads lazily once the app is idle, so it adds nothing
 * to the shell's closure.
 */
export function useNodeDirectoryPublisher(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    let stop: (() => void) | null = null;
    let disposed = false;
    const start = () => {
      void import("./nodeDirectoryPublisher")
        .then((module) => {
          if (!disposed) stop = module.startNodeDirectoryPublisher();
        })
        // A failed chunk load leaves the directory unpublished until the next mount.
        .catch(() => undefined);
    };
    const idle =
      typeof globalThis.requestIdleCallback === "function"
        ? globalThis.requestIdleCallback(start, { timeout: PUBLISHER_IDLE_TIMEOUT_MS })
        : null;
    const timer = idle === null ? globalThis.setTimeout(start, PUBLISHER_IDLE_TIMEOUT_MS) : null;
    return () => {
      disposed = true;
      if (idle !== null) globalThis.cancelIdleCallback(idle);
      if (timer !== null) globalThis.clearTimeout(timer);
      stop?.();
    };
  }, [enabled]);
}
