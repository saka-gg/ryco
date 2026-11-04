import { useEffect } from "react";

import { scheduleIdleTask } from "../lib/idleTask";

/** The publisher is not needed for first paint; it loads once the app is idle. */
const PUBLISHER_IDLE_TIMEOUT_MS = 5_000;

/** Outside the hook: React Compiler does not lower `import()` expressions. */
const loadNodeDirectoryPublisher = () => import("./nodeDirectoryPublisher");

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
    const cancelStart = scheduleIdleTask(() => {
      void loadNodeDirectoryPublisher()
        .then((module) => {
          if (!disposed) stop = module.startNodeDirectoryPublisher();
        })
        // A failed chunk load leaves the directory unpublished until the next mount.
        .catch(() => undefined);
    }, PUBLISHER_IDLE_TIMEOUT_MS);
    return () => {
      disposed = true;
      cancelStart();
      stop?.();
    };
  }, [enabled]);
}
