import { HostedRelayTrustNotice } from "./hostedHub/HostedRelayTrustNotice";
import { Button } from "./ui/button";
import { navigateHub } from "../hostedHub/hubRoutes";
import {
  retryHostedHomeDiscovery,
  useHostedWorkspaceState,
} from "../hostedHub/hostedConnectionCoordinator";
import { useRoutedHostedNode } from "../hostedHub/nodeRouteOrchestrator";

/**
 * The hosted-hub part of the empty thread surface: home discovery progress, the
 * node directory entry point, and the relay trust disclosure. Its own module so
 * standard builds resolve it to the null `NoActiveThreadHostedStatus.standard`
 * sibling (see `src/clientModeSeams.ts`) and the empty state, which sits on the
 * boot path, does not carry the hosted route orchestrator and read cache.
 */
export function NoActiveThreadHostedStatus() {
  return (
    <div className="mt-5 space-y-3 text-left">
      <HostedHomeDiscoveryStatus />
      <Button variant="outline" onClick={() => navigateHub({ kind: "nodes" })}>
        Manage nodes
      </Button>
      <HostedRelayTrustNotice compact />
    </div>
  );
}

function HostedHomeDiscoveryStatus() {
  const route = useRoutedHostedNode();
  const workspace = useHostedWorkspaceState();
  if (route.nodeId !== null || route.logicalPathname !== "/") return null;
  const discovery = workspace.homeDiscovery;
  const machine = workspace.machines.find(
    (entry) => entry.environmentId === discovery.environmentId,
  );
  return (
    <>
      {discovery.environmentId !== null ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading threads from {machine?.label ?? "your device"}…
        </p>
      ) : null}
      {discovery.failedEnvironmentIds.length > 0 ? (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Some devices could not load their thread lists. Your other threads remain available.
          </p>
          <Button variant="outline" onClick={retryHostedHomeDiscovery}>
            Retry loading threads
          </Button>
        </div>
      ) : null}
    </>
  );
}
