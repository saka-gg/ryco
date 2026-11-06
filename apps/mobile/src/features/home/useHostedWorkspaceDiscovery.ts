import { useEffect, useState, useSyncExternalStore } from "react";
import { useShallow } from "zustand/react/shallow";

import { mobileHostedConnectionScopes } from "../../connection/hostedConnectionScopes";
import { createHostedWorkspaceDiscovery } from "../../connection/hostedWorkspaceDiscovery";
import { useHostedHubStore, useMobileHostedConnectionsStore } from "../../hostedHub/state";
import { mobileAppLifecycle } from "../../platform/appLifecycle";
import { useStore } from "../../state/threadsRuntime";
import { useSavedEnvironments } from "../connection/useConnectionController";
import { selectShellCurrentByEnvironmentId } from "./homeEnvironmentModel";
import { workspaceEligibleEnvironmentIds } from "./nativeNodeEligibilityModel";
import { useAuthoritativeNodeTrust } from "./useAuthoritativeNodeTrust";

const hasMountedWork = () =>
  mobileHostedConnectionScopes.list().some((entry) => entry.scope.type !== "workspace-discovery");
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
  const hosted = useHostedHubStore(
    useShallow((state) => ({
      authority:
        state.accountStatus === "authenticated" && state.account !== null
          ? JSON.stringify([state.account.id, state.session?.id, state.session?.activeSpaceId])
          : null,
      current: state.browserStatus === "current" && state.directoryStatus === "ready",
      nodes: state.nodes,
    })),
  );
  const connections = useMobileHostedConnectionsStore((state) => state.selectedNodes);
  const shellCurrent = useStore(useShallow(selectShellCurrentByEnvironmentId));
  const trust = useAuthoritativeNodeTrust(
    hosted.nodes.map((node) => ({ nodeId: node.id, environmentId: node.environmentId })),
  );
  const { rows: direct } = useSavedEnvironments();

  useEffect(() => {
    const trusted = workspaceEligibleEnvironmentIds(trust);
    const directIds = new Set(direct.map((row) => row.record.environmentId));
    const sessions = new Map(
      connections.map((connection) => [connection.environmentId, connection]),
    );
    discovery.update({
      authority: hosted.authority,
      active: focused && foreground && hosted.current && !mountedWork,
      candidates: hosted.nodes.map((node) => {
        const session = sessions.get(node.environmentId);
        return {
          environmentId: node.environmentId,
          eligible:
            node.revokedAt === null &&
            node.presence.online &&
            trusted.has(node.environmentId) &&
            !directIds.has(node.environmentId),
          ready:
            session?.sessionEstablished === true &&
            session.sessionStatus === "ready" &&
            shellCurrent[node.environmentId] === true,
          failed: session?.transportStatus === "terminal-failure",
        };
      }),
    });
  }, [
    connections,
    direct,
    discovery,
    focused,
    foreground,
    hosted,
    mountedWork,
    shellCurrent,
    trust,
  ]);

  useEffect(() => () => discovery.reset(), [discovery]);
}
