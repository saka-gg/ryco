/**
 * How long a tab stays hidden before it stops holding connections nothing on
 * screen needs. Long enough that switching tabs and back never churns a
 * connection, short enough that an idle tab does not keep a node slot busy.
 */
export const HOSTED_HIDDEN_GRACE_MS = 90_000;

export interface HostedBrowserLifecyclePorts {
  readonly document: EventTarget;
  readonly window: EventTarget;
  readonly isVisible: () => boolean;
  readonly isOnline: () => boolean;
  readonly suspend: (reason: "hidden" | "offline") => void;
  readonly recover: () => Promise<void>;
  readonly setBackgrounded: (backgrounded: boolean) => Promise<void>;
  /**
   * Check that the account connection is still alive, or reconnect it now if
   * it is waiting out a backoff. A foreground, `online` or network-change
   * signal does not mean the old socket died — and a healthy one is
   * deliberately not replaced — but a path change can leave it open and dead,
   * which the heartbeat alone takes up to its liveness bound to notice.
   */
  readonly probe?: () => void;
  /** NetworkInformation `change`, where the browser has it. */
  readonly subscribeNetworkChange?: (listener: () => void) => () => void;
  /** Timer used for the hidden grace period; defaults to the global one. */
  readonly setTimeout?: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout?: (timer: unknown) => void;
  /** Defaults to {@link HOSTED_HIDDEN_GRACE_MS}. */
  readonly hiddenGraceMs?: number;
}

/**
 * A hidden tab can still receive events; only a real suspension ends its lease.
 * Once a tab has stayed hidden for the grace period it asks for background
 * connection planning, which lets go of connections no mounted view holds. That
 * is demand only: nothing is suspended and no authority changes, and the next
 * foreground recovery returns to foreground planning.
 */
export function bindHostedBrowserLifecycle(ports: HostedBrowserLifecyclePorts): () => void {
  const startTimer = ports.setTimeout ?? ((callback, ms) => globalThis.setTimeout(callback, ms));
  const stopTimer =
    ports.clearTimeout ??
    ((timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>));
  const hiddenGraceMs = ports.hiddenGraceMs ?? HOSTED_HIDDEN_GRACE_MS;
  let disposed = false;
  let recoveryGeneration = 0;
  // Authority was withdrawn and has not been recovered yet.
  let suspended = false;
  let graceTimer: unknown = null;
  const clearGrace = () => {
    if (graceTimer === null) return;
    stopTimer(graceTimer);
    graceTimer = null;
  };
  const startGrace = () => {
    if (disposed || suspended || graceTimer !== null || ports.isVisible()) return;
    graceTimer = startTimer(() => {
      graceTimer = null;
      if (disposed || suspended || ports.isVisible()) return;
      void ports.setBackgrounded(true);
    }, hiddenGraceMs);
  };
  const resumeIfVisible = () => {
    if (disposed || !ports.isVisible()) return;
    clearGrace();
    if (!ports.isOnline()) return;
    suspended = false;
    ports.probe?.();
    const generation = ++recoveryGeneration;
    void ports.recover().then(() => {
      if (!disposed && generation === recoveryGeneration && ports.isVisible() && ports.isOnline()) {
        return ports.setBackgrounded(false);
      }
    });
  };
  const suspend = (reason: "hidden" | "offline") => {
    recoveryGeneration++;
    suspended = true;
    clearGrace();
    // Withdraw authority synchronously before any asynchronous demand reconciliation.
    ports.suspend(reason);
    void ports.setBackgrounded(true);
  };
  const onVisibility = () => {
    if (ports.isVisible()) resumeIfVisible();
    else startGrace();
  };
  const onOffline = () => suspend("offline");
  const onFreeze = () => suspend("hidden");
  const onNetworkChange = () => {
    if (!disposed && ports.isOnline()) ports.probe?.();
  };
  ports.document.addEventListener("visibilitychange", onVisibility);
  ports.document.addEventListener("freeze", onFreeze);
  ports.document.addEventListener("resume", resumeIfVisible);
  ports.window.addEventListener("offline", onOffline);
  ports.window.addEventListener("online", resumeIfVisible);
  ports.window.addEventListener("pagehide", onFreeze);
  ports.window.addEventListener("pageshow", resumeIfVisible);
  const unsubscribeNetworkChange = ports.subscribeNetworkChange?.(onNetworkChange);
  if (!ports.isOnline()) onOffline();
  startGrace();
  return () => {
    disposed = true;
    clearGrace();
    unsubscribeNetworkChange?.();
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
