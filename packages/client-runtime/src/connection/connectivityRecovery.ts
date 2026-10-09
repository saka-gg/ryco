import type { AppLifecycleService } from "../platform/index.ts";

/** Orders platform signals; the hosted controller still owns authorization and readiness. */
export function bindConnectivityRecovery(input: {
  readonly lifecycle: AppLifecycleService;
  readonly suspend: (reason: "hidden" | "offline") => void;
  readonly releaseBackground: () => Promise<void>;
  readonly recover: () => Promise<void>;
  readonly beginWake: () => () => void;
  readonly cancelWake: () => void;
}): () => void {
  let disposed = false;
  let revision = 0;
  let requested = false;
  let running = false;
  let activeRevision: number | null = null;
  let cleanup = Promise.resolve();
  const available = () => input.lifecycle.isForeground() && input.lifecycle.isOnline();

  const run = async () => {
    if (running) return;
    running = true;
    try {
      while (requested && !disposed) {
        requested = false;
        const current = revision;
        activeRevision = current;
        await cleanup;
        if (disposed || current !== revision || !available()) continue;
        const settled = input.beginWake();
        try {
          await input.recover();
          if (!disposed && current === revision && available()) settled();
        } catch {
          // The authoritative controller owns failures and its retry policy.
        }
      }
    } finally {
      running = false;
      activeRevision = null;
    }
  };

  const unsubscribe = input.lifecycle.subscribe((event) => {
    if (event === "background" || event === "offline") {
      revision += 1;
      requested = false;
      input.cancelWake();
      // Revoke readiness synchronously, before asynchronous socket cleanup.
      input.suspend(event === "background" ? "hidden" : "offline");
      if (event === "background") {
        cleanup = cleanup.then(input.releaseBackground).catch(() => undefined);
      }
    } else if ((event === "foreground" || event === "online") && available()) {
      if (running && activeRevision === revision) return;
      requested = true;
      void run();
    }
  });
  return () => {
    disposed = true;
    revision += 1;
    unsubscribe();
    input.cancelWake();
  };
}
