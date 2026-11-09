import { getEnvironmentServerConfigsSnapshot } from "@ryco/client-runtime/rpc";
import type { NodeCatalogSnapshot } from "@ryco/client-runtime/state/nodes";
import type { WorkspaceMachineCatalogEntry } from "@ryco/client-runtime/state/workspace";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useShallow } from "zustand/react/shallow";

import { getCachedHubNodeRoster, subscribeCachedHubNodeRoster } from "../../hostedHub/nodeRoster";
import { useMobileHostedConnectionsStore } from "../../hostedHub/state";
import { subscribeEnvironmentServerConfigs } from "../../state/environmentServerConfigs";
import { useSavedEnvironments } from "../connection/useConnectionController";
import { buildMobileNativeWorkspaceCatalog } from "../home/nativeWorkspaceCatalogModel";
import { useAuthoritativeNodeTrust } from "../home/useAuthoritativeNodeTrust";
import {
  buildMobileNodeCatalog,
  EMPTY_MOBILE_NODE_CATALOG,
  stableMobileNodeCatalog,
} from "./mobileNodeCatalogModel";

/**
 * The phone's node catalog as a module store: the root host
 * (`ProjectCopyRuntimeHost`) builds it from the saved machines and the Hub's
 * and publishes it here, so the copy manager, node acquisition and the copy
 * screen read one list outside React too.
 */
let snapshot: NodeCatalogSnapshot = EMPTY_MOBILE_NODE_CATALOG;
const listeners = new Set<() => void>();

export function readMobileNodeCatalog(): NodeCatalogSnapshot {
  return snapshot;
}

export function subscribeMobileNodeCatalog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function publishMobileNodeCatalog(next: NodeCatalogSnapshot): void {
  const stable = stableMobileNodeCatalog(snapshot, next);
  if (stable === snapshot) return;
  snapshot = stable;
  for (const listener of Array.from(listeners)) listener();
}

/**
 * The Hub machines as last published (empty when signed out): a Hub session's
 * mutation lease is granted only while its machine shows connected and open to
 * changes here (`hostedCatalogAllowsMutation`), as on the hosted web.
 */
let hostedMachines: ReadonlyArray<WorkspaceMachineCatalogEntry> = [];
const hostedMachineListeners = new Set<() => void>();

export function readMobileHostedMachines(): ReadonlyArray<WorkspaceMachineCatalogEntry> {
  return hostedMachines;
}

export function subscribeMobileHostedMachines(listener: () => void): () => void {
  hostedMachineListeners.add(listener);
  return () => {
    hostedMachineListeners.delete(listener);
  };
}

function publishMobileHostedMachines(next: ReadonlyArray<WorkspaceMachineCatalogEntry>): void {
  if (next === hostedMachines) return;
  hostedMachines = next;
  for (const listener of Array.from(hostedMachineListeners)) listener();
}

const NO_HOSTED_MACHINES: ReadonlyArray<WorkspaceMachineCatalogEntry> = [];

/** The catalog, subscribed. */
export function useMobileNodeCatalog(): NodeCatalogSnapshot {
  return useSyncExternalStore(
    subscribeMobileNodeCatalog,
    readMobileNodeCatalog,
    readMobileNodeCatalog,
  );
}

/** Builds the catalog from its sources and publishes it while mounted (once, at the root). */
export function usePublishMobileNodeCatalog(): void {
  const { rows } = useSavedEnvironments();
  const hosted = useMobileHostedConnectionsStore(
    useShallow((state) => ({
      selectedNodes: state.selectedNodes,
      deliveryUnknownEnvironmentIds: state.deliveryUnknownEnvironmentIds,
    })),
  );
  const rosterNodes = useSyncExternalStore(subscribeCachedHubNodeRoster, getCachedHubNodeRoster);
  const trustByEnvironmentId = useAuthoritativeNodeTrust(rosterNodes);
  const configs = useSyncExternalStore(
    subscribeEnvironmentServerConfigs,
    getEnvironmentServerConfigsSnapshot,
    getEnvironmentServerConfigsSnapshot,
  );
  const hostedCatalog = useMemo(
    () =>
      rosterNodes.length === 0
        ? null
        : buildMobileNativeWorkspaceCatalog({
            nodes: rosterNodes,
            connections: hosted.selectedNodes,
            trustByEnvironmentId,
            deliveryUnknownEnvironmentIds: hosted.deliveryUnknownEnvironmentIds,
          }),
    [hosted, rosterNodes, trustByEnvironmentId],
  );
  const next = useMemo(
    () =>
      buildMobileNodeCatalog({
        saved: rows.map((row) => ({
          environmentId: row.record.environmentId,
          label: row.record.label,
          switchedOff: row.switchedOff,
          connectionState: row.runtime.connectionState,
          role: row.runtime.role,
          descriptor: row.runtime.descriptor,
          serverConfig: row.runtime.serverConfig,
          connectedAt: row.runtime.connectedAt,
          disconnectedAt: row.runtime.disconnectedAt,
        })),
        hosted: hostedCatalog,
        configs,
        observedAt: Date.now(),
      }),
    [configs, hostedCatalog, rows],
  );
  useEffect(() => {
    publishMobileHostedMachines(hostedCatalog ?? NO_HOSTED_MACHINES);
    publishMobileNodeCatalog(next);
  }, [hostedCatalog, next]);
}
