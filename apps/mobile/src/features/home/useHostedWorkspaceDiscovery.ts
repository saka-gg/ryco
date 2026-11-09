import { useEffect, useState, useSyncExternalStore } from "react";

import { mobileHostedConnectionScopes } from "../../connection/hostedConnectionScopes";
import { createHostedWorkspaceDiscovery } from "../../connection/hostedWorkspaceDiscovery";
import { mobileAppLifecycle } from "../../platform/appLifecycle";
import { useHostedDemandCandidates } from "./useHostedDemandCandidates";

// A Tasks surface's pre-emptible task reads are not thread work: discovery keeps running beside them.
const hasMountedWork = () =>
  mobileHostedConnectionScopes
    .list()
    .some(
      (entry) => entry.scope.type !== "workspace-discovery" && entry.scope.type !== "local-tasks",
    );
const retainDiscovery = (
  environmentId: Parameters<typeof mobileHostedConnectionScopes.retain>[0],
) => mobileHostedConnectionScopes.retain(environmentId, { type: "workspace-discovery" });

/** Home needs all machines' metadata, not a manually selected machine. */
export function useHostedWorkspaceDiscovery(focused: boolean): void {
  const [discovery] = useState(() => createHostedWorkspaceDiscovery(retainDiscovery));
  const foreground = useSyncExternalStore(
    mobileAppLifecycle.subscribe,
    mobileAppLifecycle.isForeground,
  );
  const mountedWork = useSyncExternalStore(mobileHostedConnectionScopes.subscribe, hasMountedWork);
  const { authority, current, candidates } = useHostedDemandCandidates();

  useEffect(() => {
    discovery.update({
      authority,
      active: focused && foreground && current && !mountedWork,
      candidates,
    });
  }, [authority, candidates, current, discovery, focused, foreground, mountedWork]);

  useEffect(() => () => discovery.reset(), [discovery]);
}
