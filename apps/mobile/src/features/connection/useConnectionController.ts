import { useMemo } from "react";

import {
  createEnvironmentActions,
  type EnvironmentActions,
} from "../../connection/environmentActions";
import { useConnectionRegistry } from "../../providers/ConnectionRegistryProvider";
import { deriveConnectionRows, type ConnectionRow } from "./connectionRows";
import { resolveAppPairingTarget } from "./pairingTarget";
import { useSavedEnvironmentSnapshots } from "./useSavedEnvironmentSnapshots";

export type { ConnectionRow } from "./connectionRows";

// Registry-hook rewrite (§2 Connections D / §3-24): reads the catalog stores via
// useSyncExternalStore and composes the tested environmentActions.
export function useConnectionActions(): EnvironmentActions {
  const registry = useConnectionRegistry();
  return useMemo(
    () => createEnvironmentActions({ registry, resolvePairingTarget: resolveAppPairingTarget }),
    [registry],
  );
}

export function useSavedEnvironments(): {
  readonly rows: ReadonlyArray<ConnectionRow>;
  readonly isLoading: boolean;
} {
  const { records, runtimeById, statuses, hydrated } = useSavedEnvironmentSnapshots();
  return { rows: deriveConnectionRows({ records, runtimeById, statuses }), isLoading: !hydrated };
}
