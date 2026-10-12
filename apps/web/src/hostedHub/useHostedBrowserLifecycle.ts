import { hostedAccountRecoversOnConnectivity } from "@ryco/client-runtime/authorization";
import { useEffect } from "react";

import { hostedHubController, hostedHubStore } from "./state";
import { setHostedWorkspaceBackgrounded } from "./hostedConnectionCoordinator";
import { bindHostedBrowserLifecycle } from "./browserLifecycle";
import { resumeWebHubSession } from "./hubSession";

type NetworkInformationTarget = Pick<EventTarget, "addEventListener" | "removeEventListener">;

function subscribeBrowserNetworkChange(listener: () => void): () => void {
  const connection = (navigator as Navigator & { readonly connection?: NetworkInformationTarget })
    .connection;
  if (!connection || typeof connection.addEventListener !== "function") return () => undefined;
  connection.addEventListener("change", listener);
  return () => connection.removeEventListener("change", listener);
}

function bindBrowserLifecycle(): () => void {
  return bindHostedBrowserLifecycle({
    document,
    window,
    isVisible: () => document.visibilityState === "visible",
    isOnline: () => navigator.onLine,
    suspend: (reason) => hostedHubController.suspendBrowser(reason),
    recover: () => hostedHubController.recoverAfterConnectivity(),
    setBackgrounded: setHostedWorkspaceBackgrounded,
    probe: resumeWebHubSession,
    subscribeNetworkChange: subscribeBrowserNetworkChange,
  });
}

/**
 * The single hosted browser lifecycle wiring: offline / freeze / pagehide
 * suspend authority, and foreground / online / pageshow recover it while
 * the hosted account is authenticated, or while its access check could not
 * reach the Hub. Bound for as long as the account status is one of those and
 * rebound on every change between them, exactly as the hook form was keyed on
 * the status. What a recovery runs is the controller's decision, not this
 * binding's.
 *
 * Started once by the hosted workspace owners (see `hostedWorkspaceOwners`),
 * which the boot gate retains before the hosted root has loaded and the root
 * retains while it is mounted, so a suspension during boot is not missed. The
 * tier shells mount no lifecycle listeners of their own.
 */
export function startHostedBrowserLifecycle(): () => void {
  let stopped = false;
  let boundStatus: string | null = null;
  let unbind: (() => void) | null = null;
  const sync = () => {
    if (stopped) return;
    const status = hostedHubStore.getState().accountStatus;
    if (status === boundStatus) return;
    boundStatus = status;
    unbind?.();
    unbind = hostedAccountRecoversOnConnectivity(status) ? bindBrowserLifecycle() : null;
  };
  // Rebinding can suspend at once (an offline page), which patches the store;
  // doing that from inside the store's own notification would hand the other
  // subscribers a nested publish, so a change is applied on the next microtask.
  const unsubscribe = hostedHubStore.subscribe(() => queueMicrotask(sync));
  sync();
  return () => {
    if (stopped) return;
    stopped = true;
    unsubscribe();
    unbind?.();
    unbind = null;
  };
}

/** React form of {@link startHostedBrowserLifecycle} for surfaces mounted on their own. */
export function useHostedBrowserLifecycle(): void {
  useEffect(() => startHostedBrowserLifecycle(), []);
}
