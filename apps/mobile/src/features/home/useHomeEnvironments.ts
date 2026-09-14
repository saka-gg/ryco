import { useEnvironmentServerConfigs } from "../../state/environmentServerConfigs";
import { useMemo, useSyncExternalStore } from "react";
import { useShallow } from "zustand/react/shallow";

import { getCachedHubNodeRoster, subscribeCachedHubNodeRoster } from "../../hostedHub/nodeRoster";
import {
  readEnvironmentDescriptor,
  usePrimaryEnvironmentDescriptor,
} from "../../hostedHub/primaryEnvironment";
import { useMobileHostedConnectionsStore } from "../../hostedHub/state";
import { readEnvironmentApi } from "../../connection/environmentApi";
import { selectCacheHydratedEnvironmentIds, useStore } from "../../state/threadsRuntime";
import { useSavedEnvironments } from "../connection/useConnectionController";
import { buildHomeEnvironments } from "./homeEnvironmentModel";
import { deriveNodeTrustByEnvironment } from "./nodeTrustModel";
import { useAuthoritativeNodeTrust } from "./useAuthoritativeNodeTrust";
import { buildMobileNativeWorkspaceCatalog } from "./nativeWorkspaceCatalogModel";

export function useHomeEnvironments() {
  const { rows: directRows } = useSavedEnvironments();
  const hosted = useMobileHostedConnectionsStore(
    useShallow((state) => ({
      selectedNodes: state.selectedNodes,
      deliveryUnknownEnvironmentIds: state.deliveryUnknownEnvironmentIds,
    })),
  );
  // Wave 2: the persisted Hub node roster puts every known node in the list —
  // not just the selected one — so cached content always has a label to render
  // against; cache-provenance ids mark which environments are last-known state.
  const rosterNodes = useSyncExternalStore(subscribeCachedHubNodeRoster, getCachedHubNodeRoster);
  const cacheProvenanceEnvironmentIds = useStore(useShallow(selectCacheHydratedEnvironmentIds));
  const environmentStateById = useStore((state) => state.environmentStateById);
  const primaryDescriptor = usePrimaryEnvironmentDescriptor();
  const serverConfigs = useEnvironmentServerConfigs();
  // Wave 4: trust is keyed by the roster's Hub-minted node id, which is why the
  // roster records go in whole rather than the environment ids alone. The store
  // snapshot is a stable reference between commits, so this does not re-derive
  // per render.
  const authoritativeTrustByEnvironmentId = useAuthoritativeNodeTrust(rosterNodes);
  const trustByEnvironmentId = useMemo(
    () => deriveNodeTrustByEnvironment({ authoritativeTrustByEnvironmentId }),
    [authoritativeTrustByEnvironmentId],
  );
  const nativeCatalog = useMemo(
    () =>
      buildMobileNativeWorkspaceCatalog({
        nodes: rosterNodes,
        connections: hosted.selectedNodes,
        trustByEnvironmentId: authoritativeTrustByEnvironmentId,
        deliveryUnknownEnvironmentIds: hosted.deliveryUnknownEnvironmentIds,
      }),
    [authoritativeTrustByEnvironmentId, hosted, rosterNodes],
  );
  const eligibleHostedEnvironmentIds = useMemo(
    () =>
      new Set(
        nativeCatalog
          .filter((machine) => machine.canReadMetadata && machine.cacheDisposition === "available")
          .map((machine) => machine.environmentId),
      ),
    [nativeCatalog],
  );

  return useMemo(
    () =>
      buildHomeEnvironments({
        serverConfigs,
        direct: directRows.map((row) => ({
          environmentId: row.record.environmentId,
          label: row.record.label,
          connectionState: row.runtime.connectionState,
          role: row.runtime.role,
          threadSnoozeSupported: row.runtime.descriptor?.capabilities.threadSnooze ?? false,
          threadSettlementSupported: row.runtime.descriptor?.capabilities.threadSettlement ?? false,
          shellCurrent: environmentStateById[row.record.environmentId]?.bootstrapComplete === true,
          apiAvailable: readEnvironmentApi(row.record.environmentId) !== undefined,
        })),
        hosted: hosted.selectedNodes
          .filter((connection) => eligibleHostedEnvironmentIds.has(connection.environmentId))
          .map((connection) => ({
            environmentId: connection.environmentId,
            label: connection.label,
            transportStatus: connection.transportStatus,
            sessionStatus: connection.sessionStatus,
            role: connection.effectiveRole,
            threadSnoozeSupported:
              (connection.environmentId === primaryDescriptor?.environmentId
                ? primaryDescriptor
                : readEnvironmentDescriptor(connection.environmentId)
              )?.capabilities.threadSnooze ?? false,
            threadSettlementSupported:
              connection.environmentId === primaryDescriptor?.environmentId
                ? primaryDescriptor.capabilities.threadSettlement
                : (readEnvironmentDescriptor(connection.environmentId)?.capabilities
                    .threadSettlement ?? false),
            shellCurrent:
              environmentStateById[connection.environmentId]?.bootstrapComplete === true,
            apiAvailable: readEnvironmentApi(connection.environmentId) !== undefined,
          })),
        cachedHubNodes: rosterNodes
          .filter((node) => eligibleHostedEnvironmentIds.has(node.environmentId))
          .map((node) => ({
            environmentId: node.environmentId,
            label: node.label,
            role: node.effectiveRole,
            revokedAt: node.revokedAt,
            presenceOnline: node.presenceOnline,
            lastHeartbeatAt: node.lastHeartbeatAt,
            lastAuthenticatedAt: node.lastAuthenticatedAt,
          })),
        cacheProvenanceEnvironmentIds,
        deliveryUnknownEnvironmentIds: hosted.deliveryUnknownEnvironmentIds,
        trustByEnvironmentId,
      }),
    [
      cacheProvenanceEnvironmentIds,
      directRows,
      eligibleHostedEnvironmentIds,
      environmentStateById,
      hosted,
      primaryDescriptor,
      serverConfigs,
      rosterNodes,
      trustByEnvironmentId,
    ],
  );
}
