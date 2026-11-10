import { hostedAccountRecoversOnConnectivity } from "@ryco/client-runtime/authorization";
import { bindConnectivityRecovery } from "@ryco/client-runtime/connection";
import { useEffect } from "react";

import { mobileAppLifecycle } from "../platform/appLifecycle";
import { rycoAppRuntimeNative } from "../platform/appRuntimeNative";
import { getMobileHostedConnectionCoordinator } from "../connection/hostedConnectionCoordinator";
import { createMobileBackgroundStayPolicy } from "./backgroundStay";
import { createRetainedWake } from "./retainedWake";
import { hostedHubController, hostedHubStore, useHostedHubStore } from "./state";

/**
 * Drives the hosted browser lifecycle from app foreground/background and
 * connectivity — the mobile analogue of the web hosted lifecycle.
 *
 * iOS tears down sockets once it suspends the app, so the runtime must be told
 * to suspend rather than discovering a dead socket later. A short app switch
 * keeps the connections: an iOS background task holds them open for a
 * background stay, and a return inside it only checks their heartbeats
 * (`bindConnectivityRecovery`, findings F1). Mount this ONCE, above the
 * hosted surfaces — including the locked identity screen: an account whose
 * launch-time access check could not reach the Hub keeps its stored session,
 * and foreground/online is what re-runs that check. What a recovery runs is
 * the controller's decision, not this binding's.
 */
export function useHostedAppLifecycle(): void {
  const recoverable = useHostedHubStore((state) =>
    hostedAccountRecoversOnConnectivity(state.accountStatus),
  );

  useEffect(() => {
    if (!recoverable) return;
    const retainedWake = createRetainedWake({
      read: () => hostedHubStore.getState(),
      subscribe: (listener) => hostedHubStore.subscribe(listener),
      wake: () => getMobileHostedConnectionCoordinator().reconnectRetainedAfterForeground(),
    });
    const stop = bindConnectivityRecovery({
      lifecycle: mobileAppLifecycle,
      suspend: (reason) => hostedHubController.suspendBrowser(reason),
      releaseBackground: () =>
        getMobileHostedConnectionCoordinator().releaseNonRetainedForBackground(),
      recover: () => hostedHubController.recoverAfterConnectivity(),
      beginWake: () => retainedWake.begin(),
      cancelWake: () => {
        retainedWake.cancel();
        getMobileHostedConnectionCoordinator().cancelPendingRecovery();
      },
      backgroundStay: createMobileBackgroundStayPolicy(rycoAppRuntimeNative()),
    });
    // Effect cleanup cancels pending recovery, including during Fast Refresh.
    // A remount in an already-revalidated foreground needs to unpause the
    // planner without waiting for another native foreground event. The wake
    // still waits for the authoritative access check if it has not settled.
    if (mobileAppLifecycle.isForeground() && mobileAppLifecycle.isOnline()) {
      retainedWake.begin()();
    }
    return stop;
  }, [recoverable]);
}
