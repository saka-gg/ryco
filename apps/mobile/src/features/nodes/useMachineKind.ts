import { getEnvironmentServerConfigsSnapshot } from "@ryco/client-runtime/rpc";
import type { EnvironmentId, EnvironmentMachineKind } from "@ryco/contracts";
import { useCallback, useSyncExternalStore } from "react";

import { useConnectionRegistry } from "../../providers/ConnectionRegistryProvider";
import { subscribeEnvironmentServerConfigs } from "../../state/environmentServerConfigs";
import {
  readMobileNodeCatalog,
  subscribeMobileNodeCatalog,
} from "../projectCopy/mobileNodeCatalog";
import { resolveMachineKind } from "./machineKindModel";

/**
 * One machine's kind by the phone's one rule (`resolveMachineKind`). Each
 * source is read for this machine alone, so a list row re-renders only when
 * its own machine changes.
 */
export function useMachineKind(
  environmentId: EnvironmentId,
  label: string,
  platformOs?: string | null,
): EnvironmentMachineKind {
  const { catalog } = useConnectionRegistry();
  const runtimeStore = catalog.runtimeStore;
  const readRuntime = useCallback(
    () => runtimeStore.getState().byId[environmentId],
    [environmentId, runtimeStore],
  );
  const runtime = useSyncExternalStore(runtimeStore.subscribe, readRuntime, readRuntime);
  const readConfig = useCallback(
    () => getEnvironmentServerConfigsSnapshot().get(environmentId),
    [environmentId],
  );
  const config = useSyncExternalStore(subscribeEnvironmentServerConfigs, readConfig, readConfig);
  const readCatalogKind = useCallback(
    () =>
      readMobileNodeCatalog().nodes.find((node) => node.environmentId === environmentId)
        ?.iconKind ?? null,
    [environmentId],
  );
  const catalogKind = useSyncExternalStore(
    subscribeMobileNodeCatalog,
    readCatalogKind,
    readCatalogKind,
  );
  return resolveMachineKind({
    label,
    config: config ?? runtime?.serverConfig ?? null,
    descriptor: runtime?.descriptor ?? null,
    catalogKind,
    platformOs,
  });
}
