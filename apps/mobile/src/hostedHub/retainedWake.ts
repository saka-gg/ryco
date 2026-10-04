import {
  hostedAccessAwaitsRecovery,
  hostedAccountRecoversOnConnectivity,
  type HostedHubState,
} from "@ryco/client-runtime/authorization";

type RetainedWakeState = Pick<HostedHubState, "accountStatus" | "browserStatus">;

export interface RetainedWakeDeps {
  readonly read: () => RetainedWakeState;
  readonly subscribe: (listener: () => void) => () => void;
  /** The coordinator's staggered re-acquisition of retained secondary nodes. */
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

/**
 * When to wake retained secondary nodes after a foreground or online signal.
 *
 * The wake used to run once, right after the recovery that signal started. A
 * recovery that could not reach the Hub leaves the browser `stale`, and the
 * controller's own access retry restores the selected node later; the wake's
 * acquisitions had been refused in the meantime and nothing re-ran them, so a
 * retained secondary node stayed disconnected until the next foreground. The
 * wake is now owed until the browser is current again. It runs no sooner than
 * before and grants nothing: every acquisition still goes through the
 * controller, which refuses a browser that is not current.
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
    if (!hostedAccessAwaitsRecovery(deps.read())) {
      deps.wake();
      return;
    }
    release = deps.subscribe(() => {
      const state = deps.read();
      if (state.accountStatus === "authenticated" && state.browserStatus === "current") {
        stopWaiting();
        deps.wake();
        return;
      }
      // Signed out or expired: no account is left to wake nodes for.
      if (!hostedAccountRecoversOnConnectivity(state.accountStatus)) stopWaiting();
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
