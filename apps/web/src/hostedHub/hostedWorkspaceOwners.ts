import { useEffect } from "react";

import { startHostedWorkspaceCoordinator } from "./hostedConnectionCoordinator";
import {
  getHostedNodeRouteNotice,
  parseHostedScopedThreadPath,
  startHostedNodeRouteOrchestrator,
} from "./nodeRouteOrchestrator";
import { startHostedBrowserLifecycle } from "./useHostedBrowserLifecycle";

/**
 * The hosted root's three long-lived owners — the routed-node orchestrator, the
 * workspace connection coordinator, and the browser lifecycle binding — started
 * once and shared by everyone who needs them running.
 *
 * None of them is a second lifecycle owner: each only decides *when* to invoke
 * the hosted controller's existing primitives (`selectNode`, `retrySelectedNode`,
 * `returnToDirectory`, `recoverAfterConnectivity`, `suspendBrowser`). What
 * sharing them buys is *when they start*. The boot gate retains them as soon as
 * the hosted runtime is configured, so route-derived demand reaches
 * `selectNode` — and the relay ticket — the moment the directory is ready,
 * instead of after the hosted root's chunk graph has downloaded, parsed and
 * mounted. The root retains them too, which is what keeps a root mounted on
 * its own (tests, a gate that failed to load this module) working unchanged.
 *
 * Reference-counted: the owners start on the first retain and stop on the last
 * release, in the order the root's effects used to run and clean up.
 */
let retainCount = 0;
let stopOwners: (() => void) | null = null;

export function retainHostedWorkspaceOwners(): () => void {
  retainCount += 1;
  if (retainCount === 1) {
    const stopOrchestrator = startHostedNodeRouteOrchestrator();
    const stopCoordinator = startHostedWorkspaceCoordinator({
      canDiscoverHome: () => getHostedNodeRouteNotice() === null,
    });
    const stopLifecycle = startHostedBrowserLifecycle();
    stopOwners = () => {
      stopOrchestrator();
      stopCoordinator();
      stopLifecycle();
    };
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    retainCount -= 1;
    if (retainCount > 0) return;
    const stop = stopOwners;
    stopOwners = null;
    stop?.();
  };
}

/** Hold the hosted workspace owners for as long as the calling surface is mounted. */
export function useHostedWorkspaceOwners(): void {
  useEffect(() => retainHostedWorkspaceOwners(), []);
}

/**
 * Code-only prefetch of the thread route view for a cold start that lands on a
 * thread, so its chunk graph downloads during the access check instead of
 * after the hosted root has mounted and routed. Starts no session, relay or
 * store work; a failed fetch is left for the route's own lazy load to retry.
 */
export function prefetchHostedRouteCode(logicalPathname: string): void {
  if (parseHostedScopedThreadPath(logicalPathname) === null) return;
  void import("../components/routeViews/ChatThreadRouteView").catch(() => undefined);
}
