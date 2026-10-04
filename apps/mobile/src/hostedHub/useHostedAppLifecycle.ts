import { hostedAccountRecoversOnConnectivity } from "@ryco/client-runtime/authorization";
import { useEffect } from "react";

import { mobileAppLifecycle } from "../platform/appLifecycle";
import { getMobileHostedConnectionCoordinator } from "../connection/hostedConnectionCoordinator";
import { createRetainedWake } from "./retainedWake";
import { hostedHubController, hostedHubStore, useHostedHubStore } from "./state";

/**
 * Drives the hosted browser lifecycle from app foreground/background and
 * connectivity — the mobile analogue of the web hosted lifecycle.
 *
 * iOS tears down sockets on background, so the runtime must be told to suspend
 * rather than discovering a dead socket later. Mount this ONCE, above the
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
    const unsubscribe = mobileAppLifecycle.subscribe((event) => {
      switch (event) {
        case "background":
          retainedWake.cancel();
          void (async () => {
            await getMobileHostedConnectionCoordinator().releaseNonRetainedForBackground();
            hostedHubController.suspendBrowser("hidden");
          })();
          return;
        case "offline":
          retainedWake.cancel();
          hostedHubController.suspendBrowser("offline");
          return;
        case "foreground":
        case "online": {
          const settled = retainedWake.begin();
          void hostedHubController.recoverAfterConnectivity().then(settled);
          return;
        }
        default:
          // "resume" is emitted alongside "foreground"; the resume above covers it.
          return;
      }
    });
    return () => {
      unsubscribe();
      retainedWake.cancel();
    };
  }, [recoverable]);
}
