export interface HostedBrowserLifecyclePorts {
  readonly document: EventTarget;
  readonly window: EventTarget;
  readonly isVisible: () => boolean;
  readonly isOnline: () => boolean;
  readonly suspend: (reason: "hidden" | "offline") => void;
  readonly recover: () => Promise<void>;
  readonly setBackgrounded: (backgrounded: boolean) => Promise<void>;
}

/** A hidden tab can still receive events; only a real suspension ends its lease. */
export function bindHostedBrowserLifecycle(ports: HostedBrowserLifecyclePorts): () => void {
  let disposed = false;
  let recoveryGeneration = 0;
  const resumeIfVisible = () => {
    if (disposed || !ports.isVisible() || !ports.isOnline()) return;
    const generation = ++recoveryGeneration;
    void ports.recover().then(() => {
      if (!disposed && generation === recoveryGeneration && ports.isVisible() && ports.isOnline()) {
        return ports.setBackgrounded(false);
      }
    });
  };
  const suspend = (reason: "hidden" | "offline") => {
    recoveryGeneration++;
    // Withdraw authority synchronously before any asynchronous demand reconciliation.
    ports.suspend(reason);
    void ports.setBackgrounded(true);
  };
  const onVisibility = () => {
    if (ports.isVisible()) resumeIfVisible();
  };
  const onOffline = () => suspend("offline");
  const onFreeze = () => suspend("hidden");
  ports.document.addEventListener("visibilitychange", onVisibility);
  ports.document.addEventListener("freeze", onFreeze);
  ports.document.addEventListener("resume", resumeIfVisible);
  ports.window.addEventListener("offline", onOffline);
  ports.window.addEventListener("online", resumeIfVisible);
  ports.window.addEventListener("pagehide", onFreeze);
  ports.window.addEventListener("pageshow", resumeIfVisible);
  if (!ports.isOnline()) onOffline();
  return () => {
    disposed = true;
    recoveryGeneration++;
    ports.document.removeEventListener("visibilitychange", onVisibility);
    ports.document.removeEventListener("freeze", onFreeze);
    ports.document.removeEventListener("resume", resumeIfVisible);
    ports.window.removeEventListener("offline", onOffline);
    ports.window.removeEventListener("online", resumeIfVisible);
    ports.window.removeEventListener("pagehide", onFreeze);
    ports.window.removeEventListener("pageshow", resumeIfVisible);
  };
}
