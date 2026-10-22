import {
  getReportedThreadCapabilitiesSnapshot,
  getShellSettlementRulesSnapshot,
  subscribeReportedThreadCapabilities,
} from "@ryco/client-runtime/rpc";
import { useMemo, useSyncExternalStore } from "react";
import { useShallow } from "zustand/react/shallow";

import { getCachedHubNodeRoster, subscribeCachedHubNodeRoster } from "../../hostedHub/nodeRoster";
import { useMobileHostedConnectionsStore } from "../../hostedHub/state";
import { readEnvironmentApi } from "../../connection/environmentApi";
import { selectCacheHydratedEnvironmentIds, useStore } from "../../state/threadsRuntime";
import { useSavedEnvironments } from "../connection/useConnectionController";
import {
  buildHomeEnvironments,
  homeLastSeenClock,
  selectShellCurrentByEnvironmentId,
} from "./homeEnvironmentModel";
import { deriveNodeTrustByEnvironment } from "./nodeTrustModel";
import { useAuthoritativeNodeTrust } from "./useAuthoritativeNodeTrust";
import { buildMobileNativeWorkspaceCatalog } from "./nativeWorkspaceCatalogModel";

export function useHomeEnvironments(options?: {
  /**
   * A clock the calling screen keeps ticking. Without it a cached Hub node's
   * "Offline · last seen …" text is computed once and only refreshes when the
   * list itself changes.
   */
  readonly nowMs?: number;
}) {
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
  const shellCurrentByEnvironmentId = useStore(useShallow(selectShellCurrentByEnvironmentId));
  // Changes only when a node's thread capabilities or auto-settle rule do, not on config pushes.
  const reportedThreadCapabilities = useSyncExternalStore(
    subscribeReportedThreadCapabilities,
    getReportedThreadCapabilitiesSnapshot,
    getReportedThreadCapabilitiesSnapshot,
  );
  const shellSettlementRules = useSyncExternalStore(
    subscribeReportedThreadCapabilities,
    getShellSettlementRulesSnapshot,
    getShellSettlementRulesSnapshot,
  );
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
  const lastSeenNow = homeLastSeenClock(options?.nowMs, rosterNodes.length);
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
        reportedThreadCapabilities,
        shellSettlementRules,
        direct: directRows.map((row) => ({
          environmentId: row.record.environmentId,
          label: row.record.label,
          connectionState: row.runtime.connectionState,
          role: row.runtime.role,
          descriptorCapabilities: row.runtime.descriptor?.capabilities ?? null,
          shellCurrent: shellCurrentByEnvironmentId[row.record.environmentId] === true,
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
            shellCurrent: shellCurrentByEnvironmentId[connection.environmentId] === true,
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
        ...(lastSeenNow === undefined ? {} : { now: lastSeenNow }),
      }),
    [
      cacheProvenanceEnvironmentIds,
      directRows,
      eligibleHostedEnvironmentIds,
      hosted,
      lastSeenNow,
      reportedThreadCapabilities,
      rosterNodes,
      shellCurrentByEnvironmentId,
      shellSettlementRules,
      trustByEnvironmentId,
    ],
  );
}
