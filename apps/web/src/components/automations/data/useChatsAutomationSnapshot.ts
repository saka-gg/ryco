import type { EnvironmentId, ServerConfig } from "@ryco/contracts";
import { useMemo } from "react";

import { usePrimaryEnvironmentId } from "../../../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../../../environments/runtime";
import { useEnvironmentServerConfigSelector } from "../../../hooks/useChatsAvailability";
import type { SidebarProjectSnapshot } from "../../../sidebarProjectGrouping";
import {
  buildChatsAutomationSnapshot,
  chatsAutomationRootOf,
  type ChatsAutomationDevice,
} from "./chatsAutomationScope.logic";

const selectPrimaryLabel = (config: ServerConfig | null): string | null =>
  config?.environment.label ?? null;

/**
 * The Automations dialog's "No project" entry over every connected device
 * that takes schedules without a project, or null when none does.
 */
export function useChatsAutomationSnapshot(): SidebarProjectSnapshot | null {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryRoot = useEnvironmentServerConfigSelector(
    primaryEnvironmentId,
    chatsAutomationRootOf,
  );
  const primaryLabel = useEnvironmentServerConfigSelector(primaryEnvironmentId, selectPrimaryLabel);
  const savedRuntimeById = useSavedEnvironmentRuntimeStore((state) => state.byId);
  const savedRegistry = useSavedEnvironmentRegistryStore((state) => state.byId);
  return useMemo(() => {
    const devices: ChatsAutomationDevice[] = [];
    if (primaryEnvironmentId !== null && primaryRoot !== null) {
      devices.push({ environmentId: primaryEnvironmentId, root: primaryRoot, label: primaryLabel });
    }
    for (const [id, runtime] of Object.entries(savedRuntimeById)) {
      const environmentId = id as EnvironmentId;
      if (environmentId === primaryEnvironmentId) continue;
      const root = chatsAutomationRootOf(runtime?.serverConfig ?? null);
      if (root === null) continue;
      devices.push({
        environmentId,
        root,
        label: runtime?.descriptor?.label ?? savedRegistry[environmentId]?.label ?? null,
      });
    }
    return buildChatsAutomationSnapshot({ devices, primaryEnvironmentId });
  }, [primaryEnvironmentId, primaryLabel, primaryRoot, savedRegistry, savedRuntimeById]);
}
