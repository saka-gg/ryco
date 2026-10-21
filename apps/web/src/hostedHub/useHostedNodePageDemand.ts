import type { EnvironmentId } from "@ryco/contracts";
import { useEffect } from "react";

import { isHostedHubMode } from "../env";
import { hostedWebConnectionScopes } from "./hostedConnectionScopes";

/**
 * Holds the connection demand of the node a hosted page shows, for as long as
 * it shows it. Only a thread's address names a node, so the pages that act on
 * the node under the selection cursor (Settings, Tasks) hold that node's
 * demand themselves, as a thread view does for its own node: opened on a node
 * that is not connected, from a reload or an older address, they connect it.
 * Outside the hosted build, or with no node, it holds nothing.
 */
export function useHostedNodePageDemand(environmentId: EnvironmentId | null): void {
  const hosted = isHostedHubMode();
  useEffect(() => {
    if (!hosted || environmentId === null) return;
    return hostedWebConnectionScopes.retain(environmentId, { type: "interactive" });
  }, [environmentId, hosted]);
}
