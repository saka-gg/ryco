import { hostedAccountRecoversOnConnectivity } from "@ryco/client-runtime/authorization";
import { useEffect } from "react";

import { hostedHubController, useHostedHubStore } from "./state";
import { setHostedWorkspaceBackgrounded } from "./hostedConnectionCoordinator";
import { bindHostedBrowserLifecycle } from "./browserLifecycle";

/**
 * The single hosted browser lifecycle wiring: offline / freeze / pagehide
 * suspend authority, and foreground / online / pageshow recover it while
 * the hosted account is authenticated, or while its access check could not
 * reach the Hub. Mounted exactly once at the hosted root, above the
 * presentation-tier seam, so it stays active for every authenticated hosted
 * state — including the pre-session directory, recovery-code, connecting, and
 * failure surfaces — and is unaffected by tier changes. The tier shells mount
 * no lifecycle listeners of their own. What a recovery runs is the
 * controller's decision, not this binding's.
 */
export function useHostedBrowserLifecycle(): void {
  const accountStatus = useHostedHubStore((state) => state.accountStatus);

  useEffect(() => {
    if (!hostedAccountRecoversOnConnectivity(accountStatus)) return;
    return bindHostedBrowserLifecycle({
      document,
      window,
      isVisible: () => document.visibilityState === "visible",
      isOnline: () => navigator.onLine,
      suspend: (reason) => hostedHubController.suspendBrowser(reason),
      recover: () => hostedHubController.recoverAfterConnectivity(),
      setBackgrounded: setHostedWorkspaceBackgrounded,
    });
  }, [accountStatus]);
}
