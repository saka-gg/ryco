import {
  hostedAccountRecoversOnConnectivity,
  hostedBrowserRevalidated,
  type HostedHubState,
} from "@ryco/client-runtime/authorization";

type RetainedWakeState = Pick<HostedHubState, "accountStatus" | "browserStatus">;

export interface RetainedWakeDeps {
  readonly read: () => RetainedWakeState;
  readonly subscribe: (listener: () => void) => () => void;
  /** Ask the connection coordinator to plan the retained environments again. */
  readonly wake: () => void;
}

export interface RetainedWake {
  /**
   * Start tracking the recovery a foreground or connectivity signal started.
   * The returned callback is run once that recovery has settled.
   */
  readonly begin: () => () => void;
  /** The app left the foreground or went offline: nothing is owed any more. */
  readonly cancel: () => void;
}

/** The account is signed in and this browser lifecycle has checked its access and directory. */
function revalidated(state: RetainedWakeState): boolean {
  return state.accountStatus === "authenticated" && hostedBrowserRevalidated(state.browserStatus);
}

/**
 * When to wake retained nodes after a foreground or online signal.
 *
 * The wake runs once the recovery that signal started has revalidated access:
 * the browser is `current`, or `synchronizing` — revalidated, with only the
 * selected node's own session still establishing. Each environment earns its
 * readiness from its own session, so a slow or offline selected node never holds
 * the others back. A recovery that could not reach the Hub leaves the browser
 * `stale`, and the controller's own access retry revalidates it later, so the
 * wake stays owed until then. It grants nothing: every acquisition still goes
 * through the controller, which refuses a browser that is not revalidated.
 */
export function createRetainedWake(deps: RetainedWakeDeps): RetainedWake {
  let issued = 0;
  let release: (() => void) | null = null;

  const stopWaiting = () => {
    const current = release;
    release = null;
    current?.();
  };

  const settle = () => {
    stopWaiting();
    const state = deps.read();
    if (revalidated(state)) {
      deps.wake();
      return;
    }
    // Signed out or expired: no account is left to wake nodes for.
    if (!hostedAccountRecoversOnConnectivity(state.accountStatus)) return;
    release = deps.subscribe(() => {
      const next = deps.read();
      if (revalidated(next)) {
        stopWaiting();
        deps.wake();
        return;
      }
      if (!hostedAccountRecoversOnConnectivity(next.accountStatus)) stopWaiting();
    });
  };

  return {
    begin() {
      issued += 1;
      const attempt = issued;
      stopWaiting();
      return () => {
        if (attempt === issued) settle();
      };
    },
    cancel() {
      issued += 1;
      stopWaiting();
    },
  };
}
