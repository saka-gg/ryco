import { useSyncExternalStore } from "react";

import type {
  SavedEnvironmentRecord,
  SavedEnvironmentRuntimeState,
} from "@ryco/client-runtime/connection";
import type { WsConnectionStatus } from "@ryco/client-runtime/rpc";
import type { EnvironmentId } from "@ryco/contracts";

import { useConnectionRegistry } from "../../providers/ConnectionRegistryProvider";
import { useWsConnectionStatusesForEnvironments } from "../../rpc/wsConnectionState";

export interface SavedEnvironmentSnapshots {
  readonly records: Readonly<Record<EnvironmentId, SavedEnvironmentRecord>>;
  readonly runtimeById: Readonly<Record<EnvironmentId, SavedEnvironmentRuntimeState | undefined>>;
  /** Every record's own socket status. */
  readonly statuses: ReadonlyMap<EnvironmentId, WsConnectionStatus>;
  /** The stored records have been read (or reading them failed). */
  readonly hydrated: boolean;
}

/**
 * The saved environments with everything a per-node view derives from them,
 * each one subscribed. Views build their rows from these snapshots only, never
 * from `catalog.getRuntime`, `getWsConnectionStatusForEnvironment` or
 * `catalog.hasHydrated()` in render: React Compiler caches such a read on the
 * inputs it can see, so a node that dropped would keep showing "connected".
 */
export function useSavedEnvironmentSnapshots(): SavedEnvironmentSnapshots {
  const { catalog } = useConnectionRegistry();
  const registryState = useSyncExternalStore(
    catalog.registryStore.subscribe,
    catalog.registryStore.getState,
    catalog.registryStore.getState,
  );
  const runtimeState = useSyncExternalStore(
    catalog.runtimeStore.subscribe,
    catalog.runtimeStore.getState,
    catalog.runtimeStore.getState,
  );
  const hydrated = useSyncExternalStore(
    catalog.subscribeHydration,
    catalog.hasHydrated,
    catalog.hasHydrated,
  );
  const statuses = useWsConnectionStatusesForEnvironments(
    Object.values(registryState.byId).map((record) => record.environmentId),
  );
  return { records: registryState.byId, runtimeById: runtimeState.byId, statuses, hydrated };
}
