import type { EnvironmentId } from "@ryco/contracts";

import { useDeviceName } from "../../deviceName";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime";
import { useDesktopWorkspaceState } from "../../platform/desktopWorkspace";
import {
  selectBootstrapCompleteForEnvironment,
  selectEnvironmentState,
  useStore,
} from "../../store";
import { classifyEnvironmentPresence, type EnvironmentPresenceStatus } from "./projectsModel.logic";

export type { EnvironmentPresenceStatus };

export interface EnvironmentPresence {
  readonly environmentId: EnvironmentId;
  readonly isPrimary: boolean;
  /** "This device" for the primary environment, else its device name. */
  readonly label: string;
  readonly status: EnvironmentPresenceStatus;
}

/** Live reachability and label for one environment (one device). */
export function useEnvironmentPresence(environmentId: EnvironmentId): EnvironmentPresence {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const isPrimary = environmentId === primaryEnvironmentId;
  const bootstrapComplete = useStore((state) =>
    selectBootstrapCompleteForEnvironment(state, environmentId),
  );
  const hydratedFromCache = useStore(
    (state) => selectEnvironmentState(state, environmentId).hydratedFromCacheAt !== undefined,
  );
  const savedRecord = useSavedEnvironmentRegistryStore(
    (state) => state.byId?.[environmentId] ?? null,
  );
  const savedRuntime = useSavedEnvironmentRuntimeStore(
    (state) => state.byId?.[environmentId] ?? null,
  );
  // Desktop Hub machines connect outside the saved-environment registry.
  const desktopMachine = useDesktopWorkspaceState().machines.find(
    (machine) => machine.environmentId === environmentId,
  );
  const deviceName = useDeviceName(
    environmentId,
    savedRuntime?.descriptor?.label ?? savedRecord?.label ?? desktopMachine?.label ?? null,
  );
  return {
    environmentId,
    isPrimary,
    label: isPrimary ? "This device" : deviceName,
    status: classifyEnvironmentPresence({
      isPrimary,
      bootstrapComplete,
      hydratedFromCache,
      connectionState: savedRuntime?.connectionState ?? desktopMachine?.connectionState ?? null,
      disconnectedAt:
        savedRuntime?.disconnectedAt ??
        (desktopMachine && !desktopMachine.online ? "offline" : null),
    }),
  };
}
